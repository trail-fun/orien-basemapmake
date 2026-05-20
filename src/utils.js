// 用紙サイズ: short=短辺(mm), long=長辺(mm)
export const PAPER_SIZES = {
  A3: { short: 297, long: 420 },
  A4: { short: 210, long: 297 },
}

// 縮尺の選択肢
export const SCALES = [4000, 5000, 7500, 10000, 15000, 20000, 25000]

// 縮尺ラベル
export const scaleLabel = (s) => `1:${s.toLocaleString()}`

// 印刷範囲の実距離(m)を計算
// portrait: 幅=短辺, 高さ=長辺 / landscape: 幅=長辺, 高さ=短辺
export function printSizeMeters(paperSize, orientation, scale) {
  const p = PAPER_SIZES[paperSize]
  const wMm = orientation === 'landscape' ? p.long  : p.short
  const hMm = orientation === 'landscape' ? p.short : p.long
  return { wm: (wMm / 1000) * scale, hm: (hMm / 1000) * scale }
}

// 縮尺チェック (1:4000〜1:15000 が推奨)
export function scaleWarning(scale) {
  if (scale < 4000) return '縮尺が細かすぎます（推奨: 1:4,000〜1:15,000）'
  if (scale > 15000) return '縮尺が粗すぎます（推奨: 1:4,000〜1:15,000）'
  return null
}

// 緯度1度あたりのメートル
const LAT_M = 111320
// 経度1度あたりのメートル（緯度依存）
const lngM = (lat) => LAT_M * Math.cos((lat * Math.PI) / 180)

// 印刷範囲の四隅の緯度経度を返す
export function printBounds(center, paperSize, orientation, scale) {
  if (!center) return null
  const { wm, hm } = printSizeMeters(paperSize, orientation, scale)
  const dLat = (hm / 2) / LAT_M
  const dLng = (wm / 2) / lngM(center.lat)
  return {
    north: center.lat + dLat,
    south: center.lat - dLat,
    west:  center.lng - dLng,
    east:  center.lng + dLng,
  }
}

// CP の表示シンボル
export const CP_SYMBOL = { start: '△', cp: '○', finish: '◎' }
export const CP_LABEL  = { start: 'スタート', cp: 'CP', finish: 'フィニッシュ' }
export const USAGE_LABEL = { straight: 'ST', score: 'SC', both: '両用' }

// CP の連番を再採番
export function renumberCps(cps) {
  let n = 1
  return cps.map(cp => {
    if (cp.type !== 'cp') return cp
    return { ...cp, number: n++ }
  })
}

// GeoJSON エクスポート
export function toGeoJSON(state) {
  const { cps, paperSize, orientation, scale, memo } = state
  return {
    type: 'FeatureCollection',
    metadata: {
      created_at: new Date().toISOString().slice(0, 10),
      scale: `1:${scale}`,
      output_size: paperSize,
      orientation,
      memo,
    },
    features: cps.map(cp => ({
      type: 'Feature',
      properties: {
        type:   cp.type,
        number: cp.number ?? null,
        usage:  cp.usage  ?? null,
        order:  cp.order  ?? null,
        score:  cp.score  ?? null,
        memo:   cp.memo   ?? '',
      },
      geometry: {
        type: 'Point',
        coordinates: [cp.lng, cp.lat],
      },
    })),
  }
}

// GeoJSON インポート（toGeoJSON の逆変換）
export function parseGeoJSON(text) {
  const data = JSON.parse(text)
  if (data.type !== 'FeatureCollection') throw new Error('FeatureCollection ではありません')

  const meta = data.metadata || {}

  // "1:10000" → 10000
  let scale = 10000
  if (meta.scale) {
    const m = String(meta.scale).match(/1:(\d+)/)
    if (m) scale = parseInt(m[1])
  }

  const paperSize   = PAPER_SIZES[meta.output_size] ? meta.output_size : 'A3'
  const orientation = meta.orientation === 'landscape' ? 'landscape' : 'portrait'
  const memo        = meta.memo ?? ''

  const cps = (data.features || [])
    .filter(f => f.geometry?.type === 'Point' && Array.isArray(f.geometry.coordinates))
    .map((f, i) => {
      const [lng, lat] = f.geometry.coordinates
      const p = f.properties || {}
      return {
        id:     Date.now() + i,
        type:   ['start', 'cp', 'finish'].includes(p.type) ? p.type : 'cp',
        lat,
        lng,
        usage:  p.usage  ?? null,
        order:  p.order  != null ? parseInt(p.order)  : null,
        score:  p.score  != null ? parseInt(p.score)  : null,
        memo:   p.memo   ?? '',
        number: null,
      }
    })

  // 全 CP の外接矩形の中心を printCenter に使う
  let printCenter = null
  if (cps.length > 0) {
    const lats = cps.map(c => c.lat)
    const lngs = cps.map(c => c.lng)
    printCenter = {
      lat: (Math.min(...lats) + Math.max(...lats)) / 2,
      lng: (Math.min(...lngs) + Math.max(...lngs)) / 2,
    }
  }

  return { scale, paperSize, orientation, memo, cps: renumberCps(cps), printCenter }
}

// ストレートコースの距離を計算（m単位）
// start → straight/both CP（number順）→ finish の直線距離合計
export function calcStraightDistance(cps) {
  const start  = cps.find(c => c.type === 'start')
  const finish = cps.find(c => c.type === 'finish')
  const middle = cps
    .filter(c => c.type === 'cp' && (c.usage === 'straight' || c.usage === 'both'))
    .sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
  const ordered = [...(start ? [start] : []), ...middle, ...(finish ? [finish] : [])]
  if (ordered.length < 2) return null
  let total = 0
  for (let i = 0; i < ordered.length - 1; i++) {
    total += haversineM(ordered[i].lat, ordered[i].lng, ordered[i+1].lat, ordered[i+1].lng)
  }
  return total
}

function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat/2)**2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng/2)**2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// CSV インポート
export function parseCsv(text) {
  const lines = text.trim().split('\n').filter(l => l.trim() && !l.startsWith('type'))
  return lines.map((line, i) => {
    const [type, lat, lng, usage, order, score, ...memoParts] = line.split(',')
    return {
      id:     Date.now() + i,
      type:   type?.trim() || 'cp',
      lat:    parseFloat(lat),
      lng:    parseFloat(lng),
      usage:  usage?.trim() || null,
      order:  order ? parseInt(order) : null,
      score:  score ? parseInt(score) : null,
      memo:   memoParts.join(',').trim(),
      number: null,
    }
  }).filter(cp => !isNaN(cp.lat) && !isNaN(cp.lng))
}
