import { useRef, useEffect, useState, useCallback } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import CpEditor from './CpEditor'
import {
  SCALES, scaleLabel, scaleWarning, printBounds,
  CP_SYMBOL, CP_LABEL, USAGE_LABEL, renumberCps, parseCsv, parseGeoJSON, PAPER_SIZES,
  calcStraightDistance,
} from '../utils'

const GSI_TILES = {
  std:    'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png',
  relief: 'https://cyberjapandata.gsi.go.jp/xyz/relief/{z}/{x}/{y}.png',
}

export default function MapEditor({ state, setState, onNext }) {
  const mapContainer = useRef(null)
  const mapRef = useRef(null)
  const markersRef = useRef({})
  const frameRef = useRef(false)
  const frameCornerMarkersRef = useRef([])
  const frameDraggingRef = useRef(false)
  const draggingCornerRef = useRef(-1)
  const lineRef = useRef(false)
  const markerClickedRef = useRef(false)
  const [activeTool, setActiveTool] = useState('start')
  const [editingCp, setEditingCp] = useState(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [selectedId, setSelectedId] = useState(null)
  const selectedIdRef = useRef(null)
  useEffect(() => { selectedIdRef.current = selectedId }, [selectedId])
  const [mapZoom, setMapZoom] = useState(null)
  const [dragOverIndex, setDragOverIndex] = useState(null)
  const dragIndexRef = useRef(null)
  const fileRef = useRef(null)
  const loupeRef = useRef(null)
  const loupeDivRef = useRef(null)
  const loupeMapDivRef = useRef(null)
  const geoJsonFileRef = useRef(null)
  const gpxFileRef = useRef(null)
  const gpxTracksRef = useRef([])   // [{ coords: [[lng,lat],...], times: [str|null,...] }]
  const gpxPopupRef = useRef(null)
  const [gpxFiles, setGpxFiles] = useState([])
  // Undo 履歴
  const cpsHistoryRef = useRef([])
  const prevCpsRef = useRef(state.cps)
  const isUndoingRef = useRef(false)
  const [canUndo, setCanUndo] = useState(false)
  // Undo 履歴の追跡
  useEffect(() => {
    const prev = prevCpsRef.current
    prevCpsRef.current = state.cps
    if (isUndoingRef.current) { isUndoingRef.current = false; return }
    if (state.cps !== prev) {
      cpsHistoryRef.current = [...cpsHistoryRef.current, prev].slice(-50)
      setCanUndo(true)
    }
  }, [state.cps])

  const undo = useCallback(() => {
    if (!cpsHistoryRef.current.length) return
    isUndoingRef.current = true
    const prev = cpsHistoryRef.current[cpsHistoryRef.current.length - 1]
    cpsHistoryRef.current = cpsHistoryRef.current.slice(0, -1)
    setCanUndo(cpsHistoryRef.current.length > 0)
    setState(s => ({ ...s, cps: prev }))
  }, [setState])

  const undoRef = useRef(undo)
  useEffect(() => { undoRef.current = undo }, [undo])

  // state を ref で保持（クロージャ問題の回避）
  // _activeTool は state と別管理なので上書きしないよう保持する
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = { ...state, _activeTool: stateRef.current?._activeTool }
  }, [state])

  // ── マップ初期化 ──
  useEffect(() => {
    if (mapRef.current || !mapContainer.current) return
    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: {
        version: 8,
        glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
        sources: {
          gsi: {
            type: 'raster',
            tiles: [GSI_TILES['std']],
            tileSize: 256,
            attribution: '©国土地理院',
            maxzoom: 18,
          },
        },
        layers: [{ id: 'gsi', type: 'raster', source: 'gsi' }],
      },
      center: state.printCenter ? [state.printCenter.lng, state.printCenter.lat] : [136.0, 36.0],
      zoom: 13,
      dragRotate: false,
      touchPitch: false,
      pitchWithRotate: false,
      maxPitch: 0,
    })
    // タッチ2本指回転を無効化（ピンチズームは維持）
    map.touchZoomRotate.disableRotation()
    // 矢印キーによる地図移動を無効化（印刷枠移動に使うため）
    map.keyboard.disable()
    // キーボード（Ctrl+矢印）などによる回転も封じる
    map.on('rotate', () => { map.setBearing(0) })
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }))

    map.on('load', () => {
      // 印刷範囲ポリゴン
      map.addSource('frame', { type: 'geojson', data: emptyGeoJson() })
      map.addLayer({ id: 'frame-line', type: 'line', source: 'frame',
        paint: { 'line-color': '#ff6600', 'line-width': 1.5 } })
      frameRef.current = true

      map.addSource('straight-line', { type: 'geojson', data: emptyGeoJson() })
      map.addLayer({ id: 'straight-line', type: 'line', source: 'straight-line',
        paint: { 'line-color': '#c0392b', 'line-width': 2, 'line-opacity': 0.45 } })
      lineRef.current = true

      // GPX トラック
      map.addSource('gpx-tracks', { type: 'geojson', data: emptyGeoJson() })
      map.addLayer({ id: 'gpx-line', type: 'line', source: 'gpx-tracks',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#3a6bc4', 'line-width': 1.5, 'line-opacity': 0.5 } })

      map.on('click', 'gpx-line', (e) => {
        markerClickedRef.current = true
        setTimeout(() => { markerClickedRef.current = false }, 0)

        const { lng, lat } = e.lngLat
        let nearestTime = null
        let nearestDist = Infinity
        for (const trk of gpxTracksRef.current) {
          trk.coords.forEach(([tLng, tLat], i) => {
            const d = (tLng - lng) ** 2 + (tLat - lat) ** 2
            if (d < nearestDist) { nearestDist = d; nearestTime = trk.times[i] }
          })
        }
        if (gpxPopupRef.current) gpxPopupRef.current.remove()
        gpxPopupRef.current = new maplibregl.Popup({ closeButton: true, maxWidth: '220px' })
          .setLngLat(e.lngLat)
          .setHTML(`<div style="font-size:13px;padding:2px 0">${nearestTime ? formatGpxTime(nearestTime) : '時刻データなし'}</div>`)
          .addTo(map)
      })
      map.on('mouseenter', 'gpx-line', () => { map.getCanvas().style.cursor = 'pointer' })
      map.on('mouseleave', 'gpx-line', () => { map.getCanvas().style.cursor = '' })

      // printCenter が未設定のときだけ地図中心で初期化
      const initCenter = state.printCenter ?? (() => {
        const c = map.getCenter()
        setState(s => ({ ...s, printCenter: { lat: c.lat, lng: c.lng } }))
        return { lng: c.lng, lat: c.lat }
      })()

      // 四隅ドラッグマーカーを追加
      const initBounds = printBounds(initCenter, state.paperSize, state.orientation, state.scale)
      const cornerPositions = [
        [initBounds.west, initBounds.north],
        [initBounds.east, initBounds.north],
        [initBounds.west, initBounds.south],
        [initBounds.east, initBounds.south],
      ]
      frameCornerMarkersRef.current = cornerPositions.map((pos, idx) => {
        let startCornerPos = null
        let startPrintCenter = null
        const el = createCornerHandle()
        const marker = new maplibregl.Marker({ element: el, draggable: true })
          .setLngLat(pos)
          .addTo(map)
        marker.on('dragstart', () => {
          frameDraggingRef.current = true
          draggingCornerRef.current = idx
          startCornerPos = { ...marker.getLngLat() }
          startPrintCenter = { ...stateRef.current.printCenter }
        })
        marker.on('drag', () => {
          const cur = marker.getLngLat()
          setState(s => ({
            ...s,
            printCenter: {
              lat: startPrintCenter.lat + (cur.lat - startCornerPos.lat),
              lng: startPrintCenter.lng + (cur.lng - startCornerPos.lng),
            },
          }))
        })
        marker.on('dragend', () => {
          frameDraggingRef.current = false
          draggingCornerRef.current = -1
        })
        marker.getElement().parentElement.style.zIndex = '100'
        return marker
      })

      // load 後に useEffect が再実行されないため直接描画
      map.getSource('frame').setData(boundsToGeoJson(initBounds))
      setMapZoom(map.getZoom())  // straight-line useEffect を再トリガー
    })

    map.on('zoom', () => setMapZoom(map.getZoom()))

    map.on('click', (e) => {
      if (markerClickedRef.current) return  // マーカークリック時は地図クリックを無視
      const tool = stateRef.current._activeTool
      if (!tool) return
      addCpRef.current(e.lngLat.lng, e.lngLat.lat, tool)
      // スタート配置後はCP追加へ、フィニッシュ配置後は解除、CPは連続配置
      if (tool === 'start') setActiveTool('cp')
      else if (tool !== 'cp') setActiveTool(null)
    })

    mapRef.current = map

    // ルーペ用ミニマップ初期化（opacity:0 で不可視だがサイズあり → MapLibre が正しく初期化できる）
    const lmap = new maplibregl.Map({
      container: loupeMapDivRef.current,
      style: {
        version: 8,
        sources: { gsi: { type: 'raster', tiles: [GSI_TILES[stateRef.current.mapType || 'std']], tileSize: 256, maxzoom: 18 } },
        layers: [{ id: 'gsi', type: 'raster', source: 'gsi' }],
      },
      center: state.printCenter ? [state.printCenter.lng, state.printCenter.lat] : [136.0, 36.0],
      zoom: 18,
      interactive: false,
      fadeDuration: 0,
      attributionControl: false,
    })
    loupeRef.current = lmap

    const ro = new ResizeObserver(() => map.resize())
    ro.observe(mapContainer.current)
    return () => {
      ro.disconnect()
      map.remove(); mapRef.current = null
      lmap.remove(); loupeRef.current = null
    }
  }, [])

  // activeTool を stateRef に同期
  useEffect(() => {
    stateRef.current = { ...stateRef.current, _activeTool: activeTool }
  }, [activeTool])

  // 地図種類の切り替え
  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.isStyleLoaded()) return
    map.getSource('gsi').setTiles([GSI_TILES[state.mapType]])
    const lm = loupeRef.current
    if (lm?.isStyleLoaded()) lm.getSource('gsi').setTiles([GSI_TILES[state.mapType]])
  }, [state.mapType])

  // 印刷範囲枠の更新
  useEffect(() => {
    const map = mapRef.current
    if (!map || !frameRef.current) return
    const center = state.printCenter
    if (!center) return
    const bounds = printBounds(center, state.paperSize, state.orientation, state.scale)
    map.getSource('frame').setData(boundsToGeoJson(bounds))
    // 四隅マーカーの再配置（ドラッグ中のコーナーはMapLibreが制御するためスキップ）
    const positions = [
      [bounds.west, bounds.north],
      [bounds.east, bounds.north],
      [bounds.west, bounds.south],
      [bounds.east, bounds.south],
    ]
    frameCornerMarkersRef.current.forEach((m, idx) => {
      if (idx !== draggingCornerRef.current) m?.setLngLat(positions[idx])
    })
  }, [state.printCenter, state.paperSize, state.orientation, state.scale])

  // ストレート接続線の更新
  useEffect(() => {
    const map = mapRef.current
    if (!map || !lineRef.current) return
    if (!state.showLine) {
      map.getSource('straight-line').setData(emptyGeoJson())
      return
    }
    const start = state.cps.find(c => c.type === 'start')
    const finish = state.cps.find(c => c.type === 'finish')
    const straightCps = state.cps
      .filter(c => c.type === 'cp' && (c.usage === 'straight' || c.usage === 'both'))
      .sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
    const ordered = [...(start ? [start] : []), ...straightCps, ...(finish ? [finish] : [])]
    if (ordered.length < 2) {
      map.getSource('straight-line').setData(emptyGeoJson())
      return
    }

    // マーカー半径（ピクセル）を計算してセグメントをオフセット
    const p = PAPER_SIZES[state.paperSize]
    const wMm = state.orientation === 'landscape' ? p.long : p.short
    let markerPx = 40
    if (state.printCenter) {
      const bounds = printBounds(state.printCenter, state.paperSize, state.orientation, state.scale)
      if (bounds) {
        const westPx = map.project([bounds.west, state.printCenter.lat])
        const eastPx = map.project([bounds.east, state.printCenter.lat])
        markerPx = Math.round(Math.abs(eastPx.x - westPx.x) * 15 / wMm)
      }
    }
    const r = markerPx / 2

    // 各セグメントを円の外周から外周までに短縮
    const features = []
    for (let i = 0; i < ordered.length - 1; i++) {
      const a = ordered[i], b = ordered[i + 1]
      const pA = map.project([a.lng, a.lat])
      const pB = map.project([b.lng, b.lat])
      const dx = pB.x - pA.x, dy = pB.y - pA.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist <= r * 2) continue  // 円が重なるほど近い場合はスキップ
      const ux = dx / dist, uy = dy / dist
      const llA = map.unproject([pA.x + ux * r, pA.y + uy * r])
      const llB = map.unproject([pB.x - ux * r, pB.y - uy * r])
      features.push({ type: 'Feature', geometry: {
        type: 'LineString',
        coordinates: [[llA.lng, llA.lat], [llB.lng, llB.lat]],
      }})
    }
    map.getSource('straight-line').setData({ type: 'FeatureCollection', features })
  }, [state.cps, state.showLine, state.paperSize, state.orientation, state.scale, state.printCenter, mapZoom])

  // CPマーカーの同期
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    // 印刷時1.5cm になる画面ピクセルサイズを計算
    // 印刷枠の実ピクセル幅を基準にすることでズームレベルに追従する
    const p = PAPER_SIZES[state.paperSize]
    const wMm = state.orientation === 'landscape' ? p.long : p.short
    let markerPx = 40
    if (state.printCenter) {
      const bounds = printBounds(state.printCenter, state.paperSize, state.orientation, state.scale)
      if (bounds) {
        const westPx = map.project([bounds.west, state.printCenter.lat])
        const eastPx = map.project([bounds.east, state.printCenter.lat])
        const frameWidthPx = Math.abs(eastPx.x - westPx.x)
        markerPx = Math.round(frameWidthPx * 15 / wMm)
      }
    }

    const existing = new Set(Object.keys(markersRef.current))

    state.cps.forEach(cp => {
      const key = String(cp.id)
      if (markersRef.current[key]) {
        const el = markersRef.current[key].getElement()
        // SVGをサイズ更新してから setLngLat（次のフレームで再計算されるため順序重要）
        const svg = el.querySelector('.cp-symbol-svg')
        if (svg) {
          svg.setAttribute('width', markerPx)
          svg.setAttribute('height', markerPx)
          svg.style.left = `${-markerPx / 2}px`
          svg.style.top = `${-markerPx / 2}px`
        }
        const lbl = el.querySelector('.cp-marker-inner')
        if (lbl) {
          lbl.style.top = `${Math.round(markerPx * 0.55)}px`
          lbl.style.fontSize = `${Math.round(markerPx * 0.45)}px`
          lbl.textContent = cpMarkerLabel(cp, state)
        }
        markersRef.current[key].setLngLat([cp.lng, cp.lat])
      } else {
        const el = createMarkerEl(cp, state, () => {
          markerClickedRef.current = true
          setTimeout(() => { markerClickedRef.current = false }, 0)
          setSelectedId(cp.id)
        }, () => {
          markerClickedRef.current = true
          setTimeout(() => { markerClickedRef.current = false }, 0)
          const current = stateRef.current.cps.find(c => c.id === cp.id)
          if (current) setEditingCp({ ...current })
        }, markerPx)
        const marker = new maplibregl.Marker({ element: el, draggable: true })
          .setLngLat([cp.lng, cp.lat])
          .addTo(map)
        marker.on('dragstart', () => {
          if (loupeDivRef.current) loupeDivRef.current.classList.add('active')
          loupeRef.current?.jumpTo({ center: marker.getLngLat() })
        })
        marker.on('drag', () => {
          loupeRef.current?.jumpTo({ center: marker.getLngLat() })
        })
        marker.on('dragend', () => {
          if (loupeDivRef.current) loupeDivRef.current.classList.remove('active')
          const { lng, lat } = marker.getLngLat()
          setState(s => ({ ...s, cps: s.cps.map(c => c.id === cp.id ? { ...c, lng, lat } : c) }))
        })
        markersRef.current[key] = marker
      }
      existing.delete(key)
    })

    // 削除されたマーカーを除去
    existing.forEach(key => {
      markersRef.current[key].remove()
      delete markersRef.current[key]
    })
  }, [state.cps, state.showOrder, state.showScore, state.paperSize, state.orientation, state.printCenter, state.scale, mapZoom])

  const addCp = useCallback((lng, lat, type) => {
    setState(s => {
      if (type === 'start' && s.cps.some(c => c.type === 'start')) return s
      if (type === 'finish' && s.cps.some(c => c.type === 'finish')) return s
      const newCp = { id: Date.now(), type, lng, lat, usage: type === 'cp' ? 'both' : null,
        order: null, score: null, memo: '', number: null }
      return { ...s, cps: renumberCps([...s.cps, newCp]) }
    })
  }, [setState])

  // map の click ハンドラから参照できるよう ref に保持
  const addCpRef = useRef(addCp)
  useEffect(() => { addCpRef.current = addCp }, [addCp])

  // カーソルキーで選択中CPまたは印刷枠を移動
  useEffect(() => {
    const handleKeyDown = (e) => {
      const tag = document.activeElement?.tagName.toLowerCase()
      if (['input', 'textarea', 'select'].includes(tag)) return
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return
      e.preventDefault()
      const { printCenter, paperSize, orientation, scale } = stateRef.current
      const ref = printCenter || { lat: 36, lng: 136 }
      const bounds = printBounds(ref, paperSize, orientation, scale)
      const step = e.shiftKey ? 0.003125 : 0.000625
      const dLat = (bounds.north - bounds.south) * step
      const dLng = (bounds.east  - bounds.west)  * step
      const sid = selectedIdRef.current
      if (sid !== null) {
        // 選択中CPを移動
        setState(s => ({
          ...s,
          cps: s.cps.map(cp => {
            if (cp.id !== sid) return cp
            let { lat, lng } = cp
            if (e.key === 'ArrowUp')    lat += dLat
            if (e.key === 'ArrowDown')  lat -= dLat
            if (e.key === 'ArrowRight') lng += dLng
            if (e.key === 'ArrowLeft')  lng -= dLng
            return { ...cp, lat, lng }
          }),
        }))
      } else {
        // 印刷枠を移動
        if (!printCenter) return
        setState(s => {
          if (!s.printCenter) return s
          let { lat, lng } = s.printCenter
          if (e.key === 'ArrowUp')    lat += dLat
          if (e.key === 'ArrowDown')  lat -= dLat
          if (e.key === 'ArrowRight') lng += dLng
          if (e.key === 'ArrowLeft')  lng -= dLng
          return { ...s, printCenter: { lat, lng } }
        })
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [setState])

  // Ctrl+Z でUndo
  useEffect(() => {
    const handler = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.key !== 'z') return
      const tag = document.activeElement?.tagName.toLowerCase()
      if (['input', 'textarea', 'select'].includes(tag)) return
      e.preventDefault()
      undoRef.current()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const deleteCp = (id) => {
    setState(s => ({ ...s, cps: renumberCps(s.cps.filter(c => c.id !== id)) }))
    setSelectedId(null)
  }

  const moveCp = (index, dir) => {
    setState(s => {
      const arr = [...s.cps]
      const to = index + dir
      if (to < 0 || to >= arr.length) return s
      ;[arr[index], arr[to]] = [arr[to], arr[index]]
      return { ...s, cps: renumberCps(arr) }
    })
  }

  const openEdit = (cp) => setEditingCp({ ...cp })

  const saveEdit = (edited) => {
    setState(s => ({ ...s, cps: renumberCps(s.cps.map(c => c.id === edited.id ? edited : c)) }))
    setEditingCp(null)
  }

  const handleCsvImport = (e) => {
    const file = e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const newCps = parseCsv(ev.target.result)
      setState(s => ({ ...s, cps: renumberCps([...s.cps, ...newCps]) }))
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  const handleGeoJsonImport = (e) => {
    const file = e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const imported = parseGeoJSON(ev.target.result)
        setState(s => ({ ...s, ...imported }))
        if (imported.printCenter && mapRef.current) {
          mapRef.current.flyTo({
            center: [imported.printCenter.lng, imported.printCenter.lat],
            zoom: 13,
            duration: 600,
          })
        }
      } catch {
        alert('GeoJSON の読み込みに失敗しました。このアプリで出力したファイルか確認してください。')
      }
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  const handleGpxImport = (e) => {
    const file = e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const tracks = parseGPX(ev.target.result)
        if (tracks.every(t => t.coords.length === 0)) {
          alert('GPXファイルにトラックポイントが見つかりませんでした。')
          return
        }
        gpxTracksRef.current = [...gpxTracksRef.current, ...tracks]
        setGpxFiles(f => [...f, file.name])
        const map = mapRef.current
        if (map?.getSource('gpx-tracks')) {
          map.getSource('gpx-tracks').setData({
            type: 'FeatureCollection',
            features: gpxTracksRef.current.map(t => ({
              type: 'Feature', properties: {},
              geometry: { type: 'LineString', coordinates: t.coords },
            })),
          })
        }
      } catch {
        alert('GPXファイルの読み込みに失敗しました。')
      }
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  const clearGpx = () => {
    gpxTracksRef.current = []
    setGpxFiles([])
    if (gpxPopupRef.current) { gpxPopupRef.current.remove(); gpxPopupRef.current = null }
    mapRef.current?.getSource('gpx-tracks')?.setData(emptyGeoJson())
  }

  const warn = scaleWarning(state.scale)

  return (
    <>
      <div className="header">
        <h1>🗺 オリエンテーリング ベースマップ</h1>
        <span className="step">地図編集</span>
      </div>

      <div className="editor-layout">
        {/* ルーペ：CPドラッグ中に表示される拡大鏡 */}
        <div ref={loupeDivRef} className="loupe-wrap">
          <div ref={loupeMapDivRef} className="loupe-map" />
          <div className="loupe-cross" />
        </div>
        <div className={`panel-backdrop${panelOpen ? ' open' : ''}`} onClick={() => setPanelOpen(false)} />
        <button className="panel-toggle" onClick={() => setPanelOpen(o => !o)}>
          {panelOpen ? '✕ 閉じる' : '☰ 設定'}
        </button>
        {/* 地図 */}
        <div className="map-area">
          <div ref={mapContainer} style={{ position: 'absolute', inset: 0 }} />
          {mapZoom !== null && (
            <div className="map-zoom-badge">
              zoom: {mapZoom.toFixed(2)}
            </div>
          )}
          {/* モバイル用ツールバー */}
          <div className="map-toolbar">
            {['start', 'cp', 'finish'].map(t => {
              const single = t === 'start' || t === 'finish'
              const disabled = single && state.cps.some(c => c.type === t)
              return (
                <button key={t}
                  className={`map-tool-btn${activeTool === t ? ' active' : ''}`}
                  disabled={disabled}
                  onClick={() => !disabled && setActiveTool(at => at === t ? null : t)}>
                  {CP_SYMBOL[t]}{t === 'start' ? 'ST' : t === 'finish' ? 'FN' : 'CP'}
                </button>
              )
            })}
            <button className="map-tool-btn" disabled={!canUndo} onClick={undo}>↩</button>
            <button className="map-tool-btn map-tool-primary" onClick={onNext}>出力→</button>
          </div>
        </div>

        {/* サイドパネル */}
        <div className={`side-panel${panelOpen ? ' open' : ''}`}>
          <div className="side-body">

            {/* 地図種類 */}
            <div>
              <div className="sec-title">地図種類</div>
              <div className="row">
                {['std', 'relief'].map(t => (
                  <button key={t} className={`cp-tool-btn${state.mapType === t ? ' active' : ''}`}
                    onClick={() => setState(s => ({ ...s, mapType: t }))}>
                    {t === 'std' ? '標準' : '等高線'}
                  </button>
                ))}
              </div>
            </div>

            {/* 印刷設定 */}
            <div>
              <div className="sec-title">印刷設定</div>
              <div className="row" style={{ marginBottom: 5 }}>
                <select className="ctrl-select" value={state.paperSize}
                  onChange={e => setState(s => ({ ...s, paperSize: e.target.value }))}>
                  <option value="A3">A3</option>
                  <option value="A4">A4</option>
                </select>
                <select className="ctrl-select" value={state.orientation}
                  onChange={e => setState(s => ({ ...s, orientation: e.target.value }))}>
                  <option value="portrait">縦</option>
                  <option value="landscape">横</option>
                </select>
              </div>
              <select className="ctrl-select" value={state.scale}
                onChange={e => setState(s => ({ ...s, scale: parseInt(e.target.value) }))}>
                {SCALES.map(s => <option key={s} value={s}>{scaleLabel(s)}</option>)}
              </select>
              {warn && <div className="scale-warn">⚠ {warn}</div>}
              <div style={{ fontSize: 11, color: '#888', marginTop: 5 }}>
                四隅のマークをドラッグ、またはカーソルキーで枠を移動
                <br />Shift+カーソルキーで大きく移動
              </div>
            </div>

            {/* CP追加 */}
            <div className="side-cp-section">
              <div className="sec-title">CP追加</div>
              <div className="cp-toolbar">
                {['start', 'cp', 'finish'].map(t => {
                  const single = t === 'start' || t === 'finish'
                  const disabled = single && state.cps.some(c => c.type === t)
                  const titles = { start: 'スタートはすでに配置済みです', finish: 'フィニッシュはすでに配置済みです' }
                  return (
                    <button key={t}
                      className={`cp-tool-btn${activeTool === t ? ' active' : ''}`}
                      disabled={disabled}
                      title={disabled ? titles[t] : t === 'cp' ? 'クリックで連続配置' : undefined}
                      onClick={() => !disabled && setActiveTool(at => at === t ? null : t)}>
                      {CP_SYMBOL[t]} {CP_LABEL[t]}
                    </button>
                  )
                })}
              </div>
              {activeTool && (
                <div style={{ fontSize: 11, color: '#1a3a5c', marginTop: 5 }}>
                  地図をクリックして {CP_LABEL[activeTool]} を配置
                </div>
              )}
            </div>

            {/* データ読込 */}
            <div>
              <div className="sec-title">データ読込</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <input type="file" accept=".csv" ref={fileRef} style={{ display: 'none' }}
                  onChange={handleCsvImport} />
                <button className="btn btn-secondary btn-sm"
                  onClick={() => fileRef.current.click()}>📥 CSV</button>
                <input type="file" accept=".geojson,.json" ref={geoJsonFileRef} style={{ display: 'none' }}
                  onChange={handleGeoJsonImport} />
                <button className="btn btn-secondary btn-sm"
                  title="以前に出力した GeoJSON ファイルを読み込んで再編集"
                  onClick={() => {
                    if (window.confirm('現在編集中の内容が廃棄されます。よろしいですか？')) {
                      geoJsonFileRef.current.click()
                    }
                  }}>📂 GeoJSON読込</button>
                <button className="btn btn-secondary btn-sm side-cp-section"
                  disabled={!canUndo}
                  onClick={undo}
                  title="Ctrl+Z">↩ Undo</button>
                <input type="file" accept=".gpx" ref={gpxFileRef} style={{ display: 'none' }}
                  onChange={handleGpxImport} />
                <button className="btn btn-secondary btn-sm"
                  onClick={() => gpxFileRef.current.click()}>🏃 GPX読込</button>
                {gpxFiles.length > 0 && (
                  <button className="btn btn-danger btn-sm"
                    onClick={clearGpx}>✕ GPXクリア</button>
                )}
              </div>
              {gpxFiles.length > 0 && (
                <div style={{ fontSize: 11, color: '#aaa', marginTop: 4 }}>
                  {gpxFiles.map((f, i) => <div key={i}>📍 {f}</div>)}
                </div>
              )}
            </div>

            {/* 表示オプション */}
            <div>
              <div className="sec-title">表示オプション</div>
              {[
                ['showOrder', 'ストレートの順番を表示'],
                ['showScore', 'スコアのポイントを表示'],
                ['showLine',  'ストレートの接続線を表示'],
              ].map(([key, label]) => (
                <label key={key} className="chk-row">
                  <input type="checkbox" checked={state[key]}
                    onChange={e => setState(s => ({ ...s, [key]: e.target.checked }))} />
                  {label}
                </label>
              ))}
            </div>

            {/* 全体メモ */}
            <div>
              <div className="sec-title">全体メモ</div>
              <textarea className="ctrl-input" rows={3} style={{ resize: 'vertical' }}
                value={state.memo}
                onChange={e => setState(s => ({ ...s, memo: e.target.value }))} />
            </div>

            {/* CPリスト */}
            <div>
              <div className="sec-title">CP一覧 ({state.cps.length})</div>
              <div className="cp-list">
                {state.cps.length === 0 && (
                  <div style={{ fontSize: 11, color: '#aaa' }}>CPがありません</div>
                )}
                {state.cps.map((cp, index) => (
                  <div key={cp.id}
                    className={`cp-item${selectedId === cp.id ? ' selected' : ''}${dragOverIndex === index ? ' drag-over' : ''}`}
                    draggable
                    onDragStart={e => {
                      dragIndexRef.current = index
                      e.dataTransfer.effectAllowed = 'move'
                    }}
                    onDragOver={e => { e.preventDefault(); setDragOverIndex(index) }}
                    onDragLeave={() => setDragOverIndex(null)}
                    onDrop={() => {
                      setDragOverIndex(null)
                      const from = dragIndexRef.current
                      dragIndexRef.current = null
                      if (from === null || from === index) return
                      setState(s => {
                        const arr = [...s.cps]
                        const [moved] = arr.splice(from, 1)
                        arr.splice(index, 0, moved)
                        return { ...s, cps: renumberCps(arr) }
                      })
                    }}
                    onDragEnd={() => { setDragOverIndex(null); dragIndexRef.current = null }}
                    onClick={() => setSelectedId(cp.id)}>
                    <span className="cp-drag-handle" onMouseDown={e => e.stopPropagation()}>⠿</span>
                    <span className="cp-symbol">{CP_SYMBOL[cp.type]}</span>
                    <span className="cp-name">
                      {cp.type === 'cp' ? `CP${cp.number}` : CP_LABEL[cp.type]}
                    </span>
                    {cp.usage && <span className="cp-meta">{USAGE_LABEL[cp.usage]}</span>}
                    {cp.score && <span className="cp-meta">{cp.score}pt</span>}
                    {cp.memo && <span className="cp-meta cp-memo-preview">{cp.memo.length > 8 ? cp.memo.slice(0, 8) + '…' : cp.memo}</span>}
                    <div className="cp-move-btns">
                      <button className="cp-move-btn" disabled={index === 0}
                        onClick={ev => { ev.stopPropagation(); moveCp(index, -1) }}>▲</button>
                      <button className="cp-move-btn" disabled={index === state.cps.length - 1}
                        onClick={ev => { ev.stopPropagation(); moveCp(index, 1) }}>▼</button>
                    </div>
                    <div className="cp-actions">
                      <button className="btn btn-secondary btn-sm"
                        onClick={ev => { ev.stopPropagation(); openEdit(cp) }}>編集</button>
                      <button className="btn btn-danger btn-sm"
                        onClick={ev => { ev.stopPropagation(); deleteCp(cp.id) }}>🗑</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* コース情報 */}
            {(() => {
              const distM = calcStraightDistance(state.cps)
              if (distM === null) return null
              const distStr = distM >= 1000
                ? `${(distM / 1000).toFixed(2)} km`
                : `${Math.round(distM)} m`
              return (
                <div>
                  <div className="sec-title">コース情報</div>
                  <div style={{ fontSize: 12, color: '#333', display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <span>ストレート距離: <strong>{distStr}</strong></span>
                  </div>
                </div>
              )
            })()}

          </div>

          <div className="side-footer">
            <button className="btn btn-primary btn-full" onClick={onNext}>
              出力へ →
            </button>
          </div>
        </div>
      </div>

      {editingCp && (
        <CpEditor
          cp={editingCp}
          takenTypes={state.cps.filter(c => c.id !== editingCp.id).map(c => c.type)}
          onSave={saveEdit}
          onCancel={() => setEditingCp(null)}
        />
      )}
    </>
  )
}

// ── ヘルパー ──

function emptyGeoJson() {
  return { type: 'FeatureCollection', features: [] }
}

function boundsToGeoJson({ north, south, east, west }) {
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [west, north], [east, north], [east, south], [west, south], [west, north],
        ]],
      },
    }],
  }
}

// ---- GPX ヘルパー ----
function parseGPX(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  const tracks = []
  doc.querySelectorAll('trk').forEach(trk => {
    trk.querySelectorAll('trkseg').forEach(seg => {
      const coords = [], times = []
      seg.querySelectorAll('trkpt').forEach(pt => {
        const lat = parseFloat(pt.getAttribute('lat'))
        const lon = parseFloat(pt.getAttribute('lon'))
        if (isNaN(lat) || isNaN(lon)) return
        const timeEl = pt.querySelector('time')
        coords.push([lon, lat])
        times.push(timeEl ? timeEl.textContent.trim() : null)
      })
      if (coords.length > 0) tracks.push({ coords, times })
    })
  })
  return tracks
}

function formatGpxTime(iso) {
  try {
    return new Date(iso).toLocaleString('ja-JP', {
      month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
  } catch { return iso }
}

function cpMarkerLabel(cp, state) {
  if (cp.type !== 'cp') return ''
  const parts = []
  if (state.showOrder && cp.usage !== 'score' && cp.number) parts.push(cp.number)
  if (state.showScore && cp.usage !== 'straight' && cp.score) parts.push(`${cp.score}pt`)
  return parts.join('\n')
}

function createSymbolSvg(type, size) {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('width', size)
  svg.setAttribute('height', size)
  svg.setAttribute('viewBox', '0 0 100 100')
  const color = '#c0392b'
  const sw = 9

  if (type === 'start') {
    const r = 44
    const pts = [0, 1, 2].map(i => {
      const a = -Math.PI / 2 + i * (2 * Math.PI / 3)
      return `${50 + r * Math.cos(a)},${50 + r * Math.sin(a)}`
    }).join(' ')
    const poly = document.createElementNS(ns, 'polygon')
    poly.setAttribute('points', pts)
    poly.setAttribute('fill', 'none')
    poly.setAttribute('stroke', color)
    poly.setAttribute('stroke-width', sw)
    poly.setAttribute('stroke-linejoin', 'round')
    poly.setAttribute('pointer-events', 'fill')  // 中抜き内部もクリック可能に
    svg.appendChild(poly)
  } else if (type === 'cp') {
    const c = document.createElementNS(ns, 'circle')
    c.setAttribute('cx', 50); c.setAttribute('cy', 50); c.setAttribute('r', 44)
    c.setAttribute('fill', 'none'); c.setAttribute('stroke', color); c.setAttribute('stroke-width', sw)
    c.setAttribute('pointer-events', 'fill')  // 中抜き内部もクリック可能に
    svg.appendChild(c)
  } else if (type === 'finish') {
    for (const r of [44, 28]) {
      const c = document.createElementNS(ns, 'circle')
      c.setAttribute('cx', 50); c.setAttribute('cy', 50); c.setAttribute('r', r)
      c.setAttribute('fill', 'none'); c.setAttribute('stroke', color); c.setAttribute('stroke-width', sw)
      c.setAttribute('pointer-events', 'fill')  // 中抜き内部もクリック可能に
      svg.appendChild(c)
    }
  }
  // 中心十字
  const arm = 10
  for (const [x1, y1, x2, y2] of [[50 - arm, 50, 50 + arm, 50], [50, 50 - arm, 50, 50 + arm]]) {
    const line = document.createElementNS(ns, 'line')
    line.setAttribute('x1', x1); line.setAttribute('y1', y1)
    line.setAttribute('x2', x2); line.setAttribute('y2', y2)
    line.setAttribute('stroke', color)
    line.setAttribute('stroke-width', sw * 0.2)
    line.setAttribute('pointer-events', 'none')
    svg.appendChild(line)
  }
  return svg
}

function createCornerHandle() {
  const el = document.createElement('div')
  el.className = 'corner-handle'
  el.title = 'ドラッグして印刷枠を移動'
  return el
}

function createMarkerEl(cp, state, onClick, onDoubleClick = null, markerPx = 40) {
  // 0×0 のアンカー点を作り、SVG を絶対配置で中央展開する。
  // これにより MapLibre のアンカー計算がマーカーサイズに依存しなくなり、
  // 配置ずれとサイズ変更時の位置ずれを両方防ぐ。
  const el = document.createElement('div')
  el.style.cssText = 'cursor: pointer; user-select: none; position: relative; width: 0; height: 0;'

  const svg = createSymbolSvg(cp.type, markerPx)
  svg.setAttribute('class', 'cp-symbol-svg')
  svg.style.cssText = `
    position: absolute;
    left: ${-markerPx / 2}px; top: ${-markerPx / 2}px;
    filter: drop-shadow(0 2px 4px rgba(0,0,0,.4));
    overflow: visible;
  `
  el.appendChild(svg)

  const label = document.createElement('span')
  label.className = 'cp-marker-inner'
  label.style.cssText = `
    position: absolute; top: ${Math.round(markerPx * 0.55)}px; left: 0;
    transform: translateX(-50%); font-size: ${Math.round(markerPx * 0.45)}px;
    white-space: pre; text-align: center;
    color: #c0392b; font-weight: bold;
    text-shadow: 0 1px 2px rgba(255,255,255,.9);
    pointer-events: none;
  `
  label.textContent = cpMarkerLabel(cp, state)
  el.appendChild(label)
  el.addEventListener('click', onClick)
  if (onDoubleClick) el.addEventListener('dblclick', onDoubleClick)
  return el
}
