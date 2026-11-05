/**
 * 景点好评榜 —— 把一座城市的景点排成一份可点选的口碑榜
 *
 * 数据全部来自城市包本身（rating / signature / tags / ticket / hours），
 * 不额外引入外部依赖。AI 生成的城市同样能出榜。
 */

import type { Attraction, CityPack, Tag } from '../data/types'

/** 榜单排序方式 */
export type BoardSort = 'hot' | 'rating' | 'signature' | 'free' | 'quick'

/** 榜单筛选项 */
export type BoardFilter = 'all' | 'signature' | 'free' | 'indoor' | 'match'

export interface BoardEntry {
  attraction: Attraction
  /** 名次，从 1 开始 */
  rank: number
  /** 口碑分 0-100 */
  hot: number
  /** 榜单标记，如「必去」「免费」「远郊」 */
  badges: string[]
}

export interface BoardOptions {
  /** 用户的兴趣偏好，用于给命中偏好的点加分 */
  prefs: Tag[]
  /** 出行月份 */
  month: number
  sort: BoardSort
  filter: BoardFilter
}

/** 离市中心超过这个距离算远郊（与引擎口径一致） */
const FAR_KM = 18

/** 是否远郊点 */
export function isFarSpot(a: Attraction): boolean {
  return Math.hypot(a.x, a.y) > FAR_KM
}

/**
 * 口碑分（0-100）
 *
 * 评分是底子；必去地标、命中你的偏好、当季可去都是加分项，
 * 要预约、远郊则略微减分（不是不好，是安排起来更费劲）。
 */
export function hotScore(
  a: Attraction,
  city: CityPack['city'],
  prefs: Tag[],
  month: number
): number {
  let s = a.rating * 10 // 10-50
  if (a.signature) s += 20 // 当地非去不可的地标
  const hits = a.tags.filter((t) => prefs.includes(t)).length
  s += Math.min(3, hits) * 7 // 命中偏好，最多 21
  if (city.bestMonths.includes(month)) s += 8
  if (a.ticket === 0) s += 2 // 不用买票，省心
  if (a.needBooking) s -= 2 // 要提前预约，略麻烦
  if (isFarSpot(a)) s -= 3 // 远郊，来回路上花时间
  return Math.max(0, Math.min(100, Math.round(s)))
}

/** 榜单标记 */
function badgesOf(a: Attraction): string[] {
  const out: string[] = []
  if (a.signature) out.push('必去')
  if (a.ticket === 0) out.push('免费')
  if (a.indoor) out.push('室内')
  if (a.needBooking) out.push('需预约')
  if (isFarSpot(a)) out.push('远郊')
  return out
}

/**
 * 生成好评榜
 *
 * 先算每点的口碑分，再按排序方式排，最后补上名次。
 */
export function buildBoard(pack: CityPack, opts: BoardOptions): BoardEntry[] {
  const { city, attractions } = pack

  let list = attractions.slice()

  // 筛选
  switch (opts.filter) {
    case 'signature':
      list = list.filter((a) => a.signature)
      break
    case 'free':
      list = list.filter((a) => a.ticket === 0)
      break
    case 'indoor':
      list = list.filter((a) => a.indoor)
      break
    case 'match':
      list = list.filter((a) => a.tags.some((t) => opts.prefs.includes(t)))
      break
    default:
      break
  }

  const hotOf = (a: Attraction) => hotScore(a, city, opts.prefs, opts.month)

  // 排序
  list.sort((x, y) => {
    switch (opts.sort) {
      case 'rating':
        return y.rating - x.rating || hotOf(y) - hotOf(x)
      case 'signature':
        return Number(y.signature) - Number(x.signature) || hotOf(y) - hotOf(x)
      case 'free':
        return x.ticket - y.ticket || hotOf(y) - hotOf(x)
      case 'quick':
        return x.hours - y.hours || hotOf(y) - hotOf(x)
      default:
        return hotOf(y) - hotOf(x) || y.rating - x.rating
    }
  })

  return list.map((a, i) => ({
    attraction: a,
    rank: i + 1,
    hot: hotOf(a),
    badges: badgesOf(a),
  }))
}
