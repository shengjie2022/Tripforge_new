import type { Attraction, City, Hotel, TransitMode, TransitOption } from '../data/types'

/** 两点间距离（本地公里网格，忽略球面曲率） */
export function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.sqrt(dx * dx + dy * dy)
}

/** 经纬度球面距离（km） */
/**
 * 两点间大圆距离（km）
 *
 * **入参顺序固定为 [纬度, 经度]（lat, lng）**。
 * City.coordinates 与 OriginCity.coordinates 都必须按这个顺序存。
 */
export function haversine(
  a: [number, number],
  b: [number, number]
): number {
  const R = 6371
  const dLat = ((b[0] - a[0]) * Math.PI) / 180
  const dLon = ((b[1] - a[1]) * Math.PI) / 180
  const la1 = (a[0] * Math.PI) / 180
  const la2 = (b[0] * Math.PI) / 180
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/**
 * 在给定交通方案中，为一段行程挑选最合适的出行方式。
 * 规则：优先便宜的，但当「省钱方案」比「推荐方案」多花的时间超过容忍值时，改用更快的。
 */
export function pickMode(
  distanceKm: number,
  transit: TransitOption[],
  opts: { hurry?: boolean; preferCheap?: boolean } = {}
): { mode: TransitMode; minutes: number; cost: number; option: TransitOption } {
  const walk = transit.find((t) => t.mode === 'walk')
  const metro = transit.find((t) => t.mode === 'metro')
  const bus = transit.find((t) => t.mode === 'bus')
  const taxi = transit.find((t) => t.mode === 'taxi')
  const bike = transit.find((t) => t.mode === 'bike')

  // 步行 / 骑行：距离过近时优先
  if (distanceKm < 1.2 && walk) {
    return {
      mode: 'walk',
      minutes: Math.max(5, Math.round((distanceKm / 4.8) * 60)),
      cost: 0,
      option: walk,
    }
  }
  if (distanceKm < 2.5 && bike) {
    return {
      mode: 'bike',
      minutes: Math.max(6, Math.round((distanceKm / 12) * 60)),
      cost: bike.baseCost,
      option: bike,
    }
  }

  const candidates: TransitOption[] = []
  // 公共交通只在合理距离内可选：地铁一般不超过 12km，公交不超过 18km，
  // 超出这个范围说明两地不通轨道，应走打车 / 包车 / 城际
  if (metro && distanceKm >= 1.2 && distanceKm <= 12) candidates.push(metro)
  if (bus && distanceKm >= 1.2 && distanceKm <= 18) candidates.push(bus)
  if (taxi) candidates.push(taxi)

  if (!candidates.length) {
    const fallback: TransitOption = {
      mode: 'walk',
      baseCost: 0,
      dailyCost: 0,
      speedKmh: 4.8,
      note: '步行',
    }
    return {
      mode: 'walk',
      minutes: Math.max(5, Math.round((distanceKm / 4.8) * 60)),
      cost: 0,
      option: fallback,
    }
  }

  const scored = candidates.map((opt) => {
    // 公共交通的固定等待/换乘时间
    const wait = opt.mode === 'taxi' ? 2 : opt.mode === 'metro' ? 9 : 7
    // 高速路限速 + 市内拥堵，取 30-38km/h 更接近真实车程
    const speed = opt.mode === 'taxi' ? Math.max(26, Math.min(38, opt.speedKmh)) : opt.speedKmh
    const minutes = Math.round((distanceKm / speed) * 60) + wait
    const cost = opt.mode === 'taxi'
      ? Math.round(opt.baseCost + Math.max(0, distanceKm - 3) * (opt.baseCost / 8))
      : opt.baseCost
    return { opt, minutes, cost }
  })

  if (opts.preferCheap) {
    scored.sort((a, b) => a.cost - b.cost || a.minutes - b.minutes)
  } else {
    // 平衡：先按时间排序，若某方案比最快方案贵太多但不慢太多，则优先便宜的
    const fastest = Math.min(...scored.map((s) => s.minutes))
    scored.sort((a, b) => {
      const aDelta = a.minutes - fastest
      const bDelta = b.minutes - fastest
      const aScore = aDelta + (a.cost / 20) * (opts.hurry ? 0.4 : 1.6)
      const bScore = bDelta + (b.cost / 20) * (opts.hurry ? 0.4 : 1.6)
      return aScore - bScore
    })
  }

  const best = scored[0]
  return {
    mode: best.opt.mode,
    minutes: best.minutes,
    cost: best.cost,
    option: best.opt,
  }
}

/** 把一个点的偏好得分算出来 */
export function scoreAttraction(
  a: Attraction,
  prefs: string[],
  city: City,
  month: number,
  /** 该目的地当时段是否雨季（降水日占比高） */
  rainy: boolean = false
): number {
  let score = a.rating * 10

  // 偏好标签命中：强命中加分
  for (const p of prefs) {
    if (a.tags.includes(p as never)) score += 34
  }

  // 城市标签命中（用户偏好与城市整体风格一致时加分）
  for (const p of prefs) {
    if (city.tags.includes(p as never)) score += 3
  }

  // 淡季加成：非最佳月份略微降低权重，避免推荐与季节冲突的户外点
  if (!city.bestMonths.includes(month)) {
    if (a.tags.includes('nature') || a.tags.includes('mountain') || a.tags.includes('water')) {
      score -= 8
    }
    if (a.indoor || a.tags.includes('indoor')) score += 6
  } else {
    score += 5
  }

  // 雨季：优先室内场馆，压低纯户外的点
  // （下雨天去爬山大峡谷是自找罪受，博物馆茶馆才是正解）
  if (rainy) {
    if (a.indoor) score += 20
    else if (
      a.tags.includes('nature') ||
      a.tags.includes('mountain') ||
      a.tags.includes('water')
    ) {
      score -= 9
    }
  }

  // 标志性景点保底加权，保证每个城市有"非去不可"的点
  if (a.signature) score += 22

  return score
}

/** 住宿综合得分：档位匹配 + 位置靠近行程重心 + 口碑 */
export function scoreHotel(
  hotel: Hotel,
  targetTier: Hotel['tier'],
  centroid: { x: number; y: number },
  nightCount: number,
  budgetPerNight: number
): number {
  let score = hotel.rating * 12
  if (hotel.tier === targetTier) score += 30
  if (hotel.price <= budgetPerNight) score += 14
  else score -= (hotel.price - budgetPerNight) / 18
  score -= dist(hotel, centroid) * 2.4
  // 住得越久，位置越重要
  score -= (nightCount - 1) * Math.max(0, dist(hotel, centroid) - 3) * 0.5
  return score
}
