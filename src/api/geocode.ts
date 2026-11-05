/**
 * 出发地地理编码 —— 解析内置表以外的任意城市名（县级市、区县等）
 *
 * 数据源：Photon（基于 OpenStreetMap 的开源地理编码器）
 *   - 免费、无需 API Key
 *   - 接口返回 `access-control-allow-origin: *`，浏览器可直连
 *   - 自建 OSM 实例，社区维护，稳定性不如商业服务
 *
 * 检索要点（实测得出，直接抄会匹配错城市）：
 *   1. **必须加「市」后缀**：裸搜「金华」会命中重庆的「金华区」、「保定」会命中海南的「保定村」；
 *      搜「金华市」「保定市」才稳定命中正确行政区。
 *   2. **必须过滤 countrycode=CN**：裸搜「北海」会返回日本「北海道」。
 *   3. **只看 city/county/state 级**：否则会把火车站、住宅小区也选进来。
 *
 * 解析成功后由调用方存进 localStorage，下次直接命中。
 */

/** 解析结果 */
export interface GeoHit {
  /** 城市名（带「市」后缀的正式名，如 昆山市） */
  name: string
  /** 坐标，顺序为 [纬度, 经度]（lat, lng），与 haversine 入参一致 */
  coordinates: [number, number]
  /** 所属省份 / 地区，用于界面上消歧 */
  region?: string
}

const PHOTON_ENDPOINT = 'https://photon.komoot.io/api/'

/** 可接受的 OSM 地物层级 */
const GOOD_TYPES = new Set(['city', 'county', 'state', 'town', 'district'])

interface PhotonFeature {
  properties?: {
    name?: string
    type?: string
    state?: string
    countrycode?: string
    country?: string
  }
  geometry?: { coordinates?: [number, number] }
}

interface PhotonResponse {
  features?: PhotonFeature[]
}

/** 候选检索词：原名 → 加「市」→ 加「州」，命中率依次上升 */
function queryVariants(keyword: string): string[] {
  const kw = keyword.trim()
  const list = [kw]
  if (!kw.endsWith('市') && !kw.endsWith('州') && !kw.endsWith('盟') && !kw.endsWith('县')) {
    list.push(`${kw}市`)
    list.push(`${kw}州`)
  }
  return list
}

/**
 * 解析一个城市名
 *
 * @returns 命中的行政区；找不到返回 null（**永不 throw**）
 */
export async function geocodeCity(keyword: string): Promise<GeoHit | null> {
  const kw = keyword.trim()
  if (kw.length < 2) return null

  for (const q of queryVariants(kw)) {
    let features: PhotonFeature[] = []
    try {
      const url = `${PHOTON_ENDPOINT}?q=${encodeURIComponent(q)}&limit=8`
      const res = await fetch(url, { headers: { Accept: 'application/json' } })
      if (!res.ok) continue
      const data = (await res.json()) as PhotonResponse
      features = data.features ?? []
    } catch {
      continue
    }

    const hit = pickBest(features, kw)
    if (hit) return hit
  }
  return null
}

/** 从候选里挑最合适的一条 */
function pickBest(features: PhotonFeature[], keyword: string): GeoHit | null {
  const scored = features
    .filter((f) => {
      const p = f.properties
      const t = p?.type
      if (!t || !GOOD_TYPES.has(t)) return false
      // 境外同名（比如「北海」命中日本北海道）直接排除
      if (p?.countrycode && p.countrycode !== 'CN') return false
      const coords = f.geometry?.coordinates
      if (!coords || coords.length < 2) return false
      return true
    })
    .map((f) => {
      const name = (f.properties?.name ?? '').trim()
      const region = (f.properties?.state ?? '').trim()
      const [lng, lat] = f.geometry!.coordinates as [number, number]
      // 名称里包含关键词的优先；带「市」后缀的次之
      let score = 0
      if (name.includes(keyword)) score += 10
      if (name.endsWith('市')) score += 4
      if (f.properties?.type === 'city') score += 3
      if (region) score += 1
      return { hit: { name, coordinates: [round(lat), round(lng)] as [number, number], region: region || undefined }, score }
    })
    .filter((x) => x.hit.name.length > 0)
    .sort((a, b) => b.score - a.score)

  return scored.length ? scored[0].hit : null
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000
}
