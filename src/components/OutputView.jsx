import { useRef, useEffect, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { jsPDF } from 'jspdf'
import { toGeoJSON, printBounds, PAPER_SIZES, CP_SYMBOL, CP_LABEL } from '../utils'

const GSI_TILES = {
  std:    'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png',
  relief: 'https://cyberjapandata.gsi.go.jp/xyz/relief/{z}/{x}/{y}.png',
}


export default function OutputView({ state, onBack }) {
  const mapContainer = useRef(null)
  const mapRef = useRef(null)
  const [generating, setGenerating] = useState(false)
  const pdfZoom = 18
  const { paperSize, orientation, scale, mapType, cps, printCenter, showOrder, showScore } = state

  const paper = PAPER_SIZES[paperSize]
  const wMm = orientation === 'landscape' ? paper.long : paper.short
  const hMm = orientation === 'landscape' ? paper.short : paper.long
  const aspect = wMm / hMm

  useEffect(() => {
    if (mapRef.current || !mapContainer.current) return
    const bounds = printCenter
      ? printBounds(printCenter, paperSize, orientation, scale)
      : null

    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: {
        version: 8,
        glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
        sources: {
          gsi: {
            type: 'raster',
            tiles: [GSI_TILES[mapType]],
            tileSize: 256,
            attribution: '©国土地理院',
            maxzoom: 18,
          },
        },
        layers: [{ id: 'gsi', type: 'raster', source: 'gsi' }],
      },
      center: printCenter ? [printCenter.lng, printCenter.lat] : [136.0, 36.0],
      zoom: 13,
      interactive: false,
      dragRotate: false,
      touchPitch: false,
    })

    const fitView = () => {
      if (!bounds) return
      map.fitBounds([[bounds.west, bounds.south], [bounds.east, bounds.north]], { padding: 0, animate: false })
    }

    let loaded = false
    map.on('load', () => {
      loaded = true
      map.resize()
      fitView()

      // CPマーカー追加
      cps.forEach(cp => {
        const el = document.createElement('div')
        el.style.cssText = `
          font-size: 20px; text-align: center; line-height:1;
          color: ${cp.type === 'start' ? '#1a7a1a' : cp.type === 'finish' ? '#c0392b' : '#1a3a5c'};
          filter: drop-shadow(0 1px 2px rgba(0,0,0,.4));
        `
        el.textContent = CP_SYMBOL[cp.type]
        new maplibregl.Marker({ element: el }).setLngLat([cp.lng, cp.lat]).addTo(map)
      })
    })

    mapRef.current = map
    const ro = new ResizeObserver(() => {
      map.resize()
      if (loaded) fitView()
    })
    ro.observe(mapContainer.current)
    return () => { ro.disconnect(); map.remove(); mapRef.current = null }
  }, [])

  const downloadGeoJSON = () => {
    const data = toGeoJSON(state)
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url
    a.download = `orien-basemap-${new Date().toISOString().slice(0,10)}.geojson`
    a.click(); URL.revokeObjectURL(url)
  }

  const downloadPDF = async () => {
    if (!printCenter || generating) return
    setGenerating(true)

    const bounds = printBounds(printCenter, paperSize, orientation, scale)

    // コンテナ幅を画面幅いっぱいにし、高さをアスペクト比から算出する。
    // portrait では高さが viewport を超えることがあるが、position:fixed 要素の
    // clientHeight は viewport にクリップされないため WebGL は全面を正常に描画する。
    const ratio = wMm / hMm
    const cW = window.innerWidth - 4
    const cH = Math.round(cW / ratio)

    const offDiv = document.createElement('div')
    offDiv.style.cssText = `position:fixed;top:0;left:0;width:${cW}px;height:${cH}px;opacity:0;pointer-events:none;z-index:9999;`
    document.body.appendChild(offDiv)

    let offMap = null
    try {
      offMap = new maplibregl.Map({
        container: offDiv,
        style: {
          version: 8,
          sources: {
            gsi: {
              type: 'raster',
              tiles: [GSI_TILES[mapType]],
              tileSize: 256,
              maxzoom: 18,
            },
          },
          layers: [{ id: 'gsi', type: 'raster', source: 'gsi' }],
        },
        center: [printCenter.lng, printCenter.lat],
        zoom: pdfZoom,
        interactive: false,
        preserveDrawingBuffer: true,
        fadeDuration: 0,
        attributionControl: false,
      })

      await new Promise(resolve => offMap.once('load', resolve))

      // fitBounds でキャンバス全体が印刷範囲にぴったり一致する
      offMap.fitBounds(
        [[bounds.west, bounds.south], [bounds.east, bounds.north]],
        { padding: 0, animate: false }
      )
      await new Promise(resolve => offMap.once('idle', resolve))

      // fitBounds はアスペクト比の丸め誤差で印刷範囲より少し広く表示することがある。
      // project() で印刷範囲の正確なピクセル座標を取得してクロップする。
      const pW = offMap.project([bounds.west,  printCenter.lat])
      const pE = offMap.project([bounds.east,  printCenter.lat])
      const pN = offMap.project([printCenter.lng, bounds.north])
      const pS = offMap.project([printCenter.lng, bounds.south])
      const mapLeft = pW.x, mapTop = pN.y
      const mapW = pE.x - pW.x, mapH = pS.y - pN.y

      const mapCanvas = await new Promise(resolve => {
        offMap.once('render', () => resolve(offMap.getCanvas()))
        offMap.triggerRepaint()
      })
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
      const cropCanvas = document.createElement('canvas')
      cropCanvas.width  = Math.round(mapW * dpr)
      cropCanvas.height = Math.round(mapH * dpr)
      cropCanvas.getContext('2d').drawImage(
        mapCanvas,
        Math.round(mapLeft * dpr), Math.round(mapTop * dpr),
        Math.round(mapW * dpr),    Math.round(mapH * dpr),
        0, 0, cropCanvas.width, cropCanvas.height
      )
      const imgData = cropCanvas.toDataURL('image/jpeg', 0.88)

      const orient = orientation === 'landscape' ? 'l' : 'p'
      const pdf = new jsPDF({ orientation: orient, unit: 'mm', format: paperSize.toLowerCase() })
      pdf.addImage(imgData, 'JPEG', 0, 0, wMm, hMm)

      // CPシンボルをベクターで描画（半径7.5mm = 1.5cm）
      const R = 7.5
      pdf.setDrawColor(192, 57, 43)
      pdf.setLineWidth(0.8)

      cps.forEach(cp => {
        const proj = offMap.project([cp.lng, cp.lat])
        const xMm = ((proj.x - mapLeft) / mapW) * wMm
        const yMm = ((proj.y - mapTop)  / mapH) * hMm
        if (xMm < -R || xMm > wMm + R || yMm < -R || yMm > hMm + R) return

        if (cp.type === 'start') {
          const pts = [0, 1, 2].map(i => {
            const a = -Math.PI / 2 + i * (2 * Math.PI / 3)
            return [xMm + R * Math.cos(a), yMm + R * Math.sin(a)]
          })
          pdf.lines(
            [[pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]],
             [pts[2][0] - pts[1][0], pts[2][1] - pts[1][1]]],
            pts[0][0], pts[0][1], [1, 1], 'S', true
          )
        } else if (cp.type === 'cp') {
          pdf.circle(xMm, yMm, R, 'S')
          const lines = []
          if (showOrder && cp.usage !== 'score' && cp.number) lines.push(String(cp.number))
          if (showScore && cp.usage !== 'straight' && cp.score) lines.push(`${cp.score}pt`)
          if (lines.length > 0) {
            pdf.setFontSize(12)
            pdf.setTextColor(192, 57, 43)
            lines.forEach((line, i) => {
              pdf.text(line, xMm, yMm + R + 5 + i * 5, { align: 'center' })
            })
            pdf.setDrawColor(192, 57, 43)
            pdf.setLineWidth(0.8)
          }
        } else if (cp.type === 'finish') {
          pdf.circle(xMm, yMm, R * 0.55, 'S')
          pdf.circle(xMm, yMm, R, 'S')
        }

        // 中心十字（編集画面と同じ比率: arm=10/44*R, 線幅=主線の0.2倍）
        const arm = R * (10 / 44)
        pdf.setLineWidth(0.8 * 0.2)
        pdf.line(xMm - arm, yMm, xMm + arm, yMm)
        pdf.line(xMm, yMm - arm, xMm, yMm + arm)
        pdf.setLineWidth(0.8)
      })

      const margin = 4
      pdf.setFontSize(7)
      pdf.setTextColor(80)
      pdf.text('©国土地理院', margin, hMm - margin)
      if (state.memo) {
        pdf.text(`メモ: ${state.memo}`, margin, hMm - margin - 5)
      }

      pdf.save(`orien-basemap-${new Date().toISOString().slice(0,10)}.pdf`)
    } catch (err) {
      console.error('PDF生成エラー', err)
      alert('PDF の生成に失敗しました')
    } finally {
      offMap?.remove()
      if (offDiv.parentNode) document.body.removeChild(offDiv)
      setGenerating(false)
    }
  }

  return (
    <>
      <div className="header">
        <button className="btn btn-secondary btn-sm" onClick={onBack}>← 戻る</button>
        <h1>🗺 オリエンテーリング ベースマップ</h1>
        <span className="step">出力</span>
      </div>

      <div className="output-layout">
        <div className="preview-box" style={{ aspectRatio: aspect, position: 'relative' }}>
          <div ref={mapContainer} style={{ position: 'absolute', inset: 0 }} />
        </div>

        <div className="output-btns">
          <button className="btn btn-primary" disabled={generating} onClick={downloadPDF}>
            {generating ? '⏳ 生成中...' : `📄 PDF ダウンロード (${paperSize} ${orientation === 'portrait' ? '縦' : '横'})`}
          </button>
          <button className="btn btn-secondary" onClick={downloadGeoJSON}>
            📦 GeoJSON ダウンロード（サービス2用）
          </button>
        </div>

        {/* CP一覧 */}
        {cps.length > 0 && (
          <div style={{ width: '100%', maxWidth: 700 }}>
            <div className="sec-title" style={{ marginBottom: 8 }}>CP一覧</div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: '#f0f0f0' }}>
                  <th style={th}>記号</th><th style={th}>番号</th>
                  <th style={th}>用途</th><th style={th}>ポイント</th>
                  <th style={th}>緯度</th><th style={th}>経度</th><th style={th}>メモ</th>
                </tr>
              </thead>
              <tbody>
                {cps.map(cp => (
                  <tr key={cp.id} style={{ borderBottom: '1px solid #eee' }}>
                    <td style={td}>{CP_SYMBOL[cp.type]}</td>
                    <td style={td}>{cp.type === 'cp' ? `CP${cp.number}` : CP_LABEL[cp.type]}</td>
                    <td style={td}>{cp.usage || '-'}</td>
                    <td style={td}>{cp.score ? `${cp.score}pt` : '-'}</td>
                    <td style={td}>{cp.lat.toFixed(6)}</td>
                    <td style={td}>{cp.lng.toFixed(6)}</td>
                    <td style={td}>{cp.memo || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="credit">出典：国土地理院</div>
      </div>
    </>
  )
}

const th = { padding: '4px 8px', textAlign: 'left', fontWeight: 600 }
const td = { padding: '4px 8px' }
