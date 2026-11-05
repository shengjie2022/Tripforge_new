import type {
  Attraction,
  BudgetStyle,
  CityPack,
  DailyWeather,
  Hotel,
  HotelTier,
  Pace,
  Tag,
  TimeSlot,
  TransitOption,
} from '../data/types'
import { dist, haversine, pickMode, scoreAttraction, scoreHotel } from './geo'
import { findOrigin } from '../data/origins'
import { buildMeals, type MealItem } from './meals'
import { addDays, formatCN, parseISO, weekdayCN } from '../utils/date'

/** 用户输入 */
export interface TripRequest {
  cityId: string
  /** 出发地（城市名，用于估算大交通） */
  origin: string
  days: number
  /** 总预算（元） */
  budget: number
  travelers: number
  style: BudgetStyle
  pace: Pace
  /** 出行月份 1-12 */
  month: number
  /** 兴趣偏好 */
  prefs: Tag[]
  /** 是否包含往返大交通预算 */
  includeTransport: boolean
  /** 出发日期（YYYY-MM-DD），用于标注真实日期、查票价、导出日历 */
  startDate?: string
  /** 出行时段是否雨季（由天气数据判定）——雨季优先排室内场馆 */
  rainy?: boolean
  /** 逐日天气（按天对齐，第 0 项对应第 1 天）—— 供每日行程展示 */
  dailyWeather?: DailyWeather[]
  /** 用户在「景点好评榜」里点选的景点 id（优先安排，保证排进行程） */
  mustVisit?: string[]
  /** 只安排用户点选的景点，不再自动补充其它景点 */
  onlyMustVisit?: boolean
}

/** 一天中的一段行程 */
export interface DayItem {
  attraction: Attraction
  startTime: string
  endTime: string
  /** 是否为用户在「景点好评榜」里点选的景点 */
  picked?: boolean
  /** 从上一个点到这个点的交通 */
  transit?: {
    mode: TransitOption['mode']
    minutes: number
    cost: number
    distanceKm: number
    note: string
  }
}

export interface DayPlan {
  day: number
  dateLabel: string
  title: string
  items: DayItem[]
  /** 当日市内交通费 */
  transitCost: number
  /** 当日门票合计 */
  ticketCost: number
  /** 当日餐饮实测（三餐人均合计 × 人数） */
  foodCost: number
  /** 当日三餐安排（按当天片区挑店，落在真实空档里） */
  meals: MealItem[]
  /**
   * 三个餐次各自的人均价
   *
   * 排不进日程的餐次也在里面 —— 那顿饭你照样得吃。
   * 餐饮预算按这个口径算，不是只算排出来的（实测：八分之一的行程日只排得出 1-2 餐，
   * 只按排出来的算，预算会凭空少几百块）。
   */
  mealSlotCosts: { breakfast: number; lunch: number; dinner: number }
  /** 当天天气（没有天气数据时为 undefined） */
  weather?: DailyWeather
  /** 当日总耗时（小时） */
  hours: number
  zone: string
  note: string
}

export interface LodgingSuggestion {
  hotel: Hotel
  /** 为什么推荐 */
  reason: string
  /** 距主要景点的平均距离 */
  avgDistance: number
  nights: number
  totalCost: number
  alternatives: Hotel[]
}

export interface BudgetItem {
  key: string
  label: string
  amount: number
  ratio: number
  detail: string
}

/** 用户点选景点的编排结果 */
export interface PickResult {
  /** 点选的景点 id */
  selected: string[]
  /** 成功排入行程的景点 id */
  placed: string[]
  /** 因天数 / 时长 / 距离限制没能排进去的景点 id */
  missing: string[]
}

export interface TripPlan {
  request: TripRequest
  cityName: string
  days: DayPlan[]
  lodging: LodgingSuggestion
  budgetItems: BudgetItem[]
  totalBudget: number
  perDayBudget: number
  perPersonBudget: number
  /** 预估总花费 */
  estimatedCost: number
  transitPlan: {
    /** 到达方式 */
    arrival: { mode: string; cost: number; duration: string; note: string }
    /** 离开方式 */
    departure: { mode: string; cost: number; duration: string; note: string }
    /** 市内交通主推 */
    cityTransit: {
      mode: TransitOption['mode']
      label: string
      dailyCost: number
      note: string
    }
  }
  tips: string[]
  warnings: string[]
  /** 最佳出行窗口 */
  bestWindow: string
  /** 用户点选景点的编排结果（没点选时为 undefined） */
  picks?: PickResult
}

/**
 * 合法的风格 / 节奏取值（外部输入白名单）
 *
 * style 与 pace 可能来自被手改过的 URL。
 *   - 非法 style → BUDGET_RATIO[style] 取到 undefined → `ratio.stay` 直接抛错，整页白屏；
 *   - 非法 pace  → SPOTS_PER_DAY[pace] 取到 undefined → `x > undefined` 恒为 false，
 *     于是每天点数与时长上限全部失效（实测 pace='foo' 能排出 5 个点 / 14 小时的一天）。
 */
const VALID_STYLES = new Set<BudgetStyle>(['thrifty', 'balanced', 'premium'])
const VALID_PACES = new Set<Pace>(['packed', 'balanced', 'relaxed'])

/** 各风格的预算分配比例 */
const BUDGET_RATIO: Record<BudgetStyle, Record<string, number>> = {
  thrifty: { stay: 0.30, transit: 0.18, food: 0.26, ticket: 0.16, other: 0.10 },
  balanced: { stay: 0.35, transit: 0.15, food: 0.24, ticket: 0.15, other: 0.11 },
  premium: { stay: 0.45, transit: 0.14, food: 0.20, ticket: 0.12, other: 0.09 },
}

/** 每人每天餐饮基准（元） */
const FOOD_PER_DAY: Record<BudgetStyle, number> = {
  thrifty: 90,
  balanced: 160,
  premium: 320,
}

/** 每天可安排的活动时长上限（小时） */
const DAILY_HOURS: Record<Pace, number> = {
  packed: 11,
  balanced: 8.5,
  relaxed: 6,
}

/** 每天景点数量上限 */
const SPOTS_PER_DAY: Record<Pace, number> = {
  packed: 5,
  balanced: 3,
  relaxed: 2,
}

/** 时间槽起始时刻（小时，24 小时制浮点） */
const SLOT_START: Record<TimeSlot, number> = {
  morning: 9.0,
  any: 9.0,
  afternoon: 13.5,
  evening: 19.0,
}

/** 24 小时制时间格式化（09:30 / 13:30 / 19:00） */
function fmtTime(h: number): string {
  const total = Math.round(h * 60)
  const hh = Math.floor(total / 60) % 24
  const mm = total % 60
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

/** 24 小时制时间解析 */
function parseTime(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return h + m / 60
}

/**
 * 超过这个半径的点视为远郊，当天只安排同样远的点。
 * 12km 是分界：市内轨道交通一般覆盖到 10-12km，
 * 超过这个距离往往要打车 40 分钟以上，单独安排更合理。
 */
const FAR_RADIUS_KM = 18

/** 远郊判定：点自身离市中心太远 */
const isFar = (a: Attraction) => Math.hypot(a.x, a.y) > FAR_RADIUS_KM

/** 一组点的重心 */
const centerOf = (items: Attraction[]) => ({
  x: items.reduce((s, a) => s + a.x, 0) / items.length,
  y: items.reduce((s, a) => s + a.y, 0) / items.length,
})

/**
 * 地理聚类（完全链接）：簇内任意两点距离都小于 8km 才合并。
 * 用完全链接而非单链，避免串珠效应 —— 都江堰(34km)、青城山(31km)、
 * 熊猫基地(8.7km) 会被单链串成一簇，完全链接下则会正确拆开。
 */
function clusterAttractions(attractions: Attraction[]): Attraction[][] {
  let clusters: Attraction[][] = attractions.map((a) => [a])
  const MERGE_DIST = 8
  let merged = true
  while (merged) {
    merged = false
    outer: for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        let maxD = 0
        for (const a of clusters[i]) {
          for (const b of clusters[j]) {
            const d = dist(a, b)
            if (d > maxD) maxD = d
          }
        }
        if (maxD < MERGE_DIST) {
          clusters[i] = [...clusters[i], ...clusters[j]]
          clusters.splice(j, 1)
          merged = true
          break outer
        }
      }
    }
  }
  return clusters
}

/**
 * 把选中的景点分配到每天。
 *
 * 核心约束：同一天内任意两点的直线距离不得超过 MAX_SPREAD_KM，
 * 且远郊点（离市中心 >18km）当天只安排同样远的点。
 * 这两条约束自动解决了远郊问题 —— 都江堰（34km 外）和黄龙溪（22km 外）
 * 永远不会和市中心点位排到同一天。
 */
const MAX_SPREAD_KM = 15

function distributeIntoDays(
  attractions: Attraction[],
  days: number,
  pace: Pace,
  mustIds: Set<string> = new Set()
): { buckets: Attraction[][]; missingMust: Attraction[] } {
  const perDay = SPOTS_PER_DAY[pace]
  const maxHours = DAILY_HOURS[pace]

  const buckets: Attraction[][] = Array.from({ length: days }, () => [])
  const bucketsHours: Array<number> = Array.from({ length: days }, () => 0)
  /** 已经占好位置（含用户点选的点） */
  const placed = new Set<string>()

  const clusters = clusterAttractions(attractions)

  /**
   * 找一个能放下这个点的天。
   * 约束与自动选点完全一致：每日点数、每日时长、远郊不混市区、夜间点配额、同日间距。
   */
  const bestDayFor = (a: Attraction): number => {
    const far = isFar(a)
    let target = -1
    let bestScore = -Infinity
    for (let d = 0; d < days; d++) {
      const day = buckets[d]
      if (day.length + 1 > perDay) continue
      if (bucketsHours[d] + a.hours > maxHours) continue
      if (day.length > 0 && far !== day.some(isFar)) continue
      const dayEvening = day.filter((b) => b.bestTime === 'evening').length
      if (a.bestTime === 'evening' && dayEvening >= 1) continue
      const dd = day.length ? Math.max(...day.map((b) => dist(a, b))) : 0
      if (dd > MAX_SPREAD_KM) continue
      const score = -dd * 2 - day.length * 1.5
      if (score > bestScore) {
        bestScore = score
        target = d
      }
    }
    return target
  }

  // ---- 第 0 步：用户点选的点优先占位 ----
  // 远郊点更难安置（要独占一天），所以先给它们占位，城区点再填剩下的天。
  const mustItems = attractions.filter((a) => mustIds.has(a.id))
  const mustOrdered = [...mustItems].sort((a, b) => Number(isFar(b)) - Number(isFar(a)))
  for (const a of mustOrdered) {
    const target = bestDayFor(a)
    if (target < 0) continue
    buckets[target].push(a)
    bucketsHours[target] += a.hours
    placed.add(a.id)
  }

  // 簇的安置顺序：远郊簇优先（它们最挑剔，必须先占位），其次按簇大小降序
  const ordered = [...clusters].sort((a, b) => {
    const aFar = a.some(isFar) ? 1 : 0
    const bFar = b.some(isFar) ? 1 : 0
    if (aFar !== bFar) return bFar - aFar
    if (b.length !== a.length) return b.length - a.length
    const hb = b.reduce((s, x) => s + x.hours, 0)
    const ha = a.reduce((s, x) => s + x.hours, 0)
    return ha - hb
  })

  /**
   * 放进某天后，簇与该天现有点的最大间距。
   * 同时包含簇内部两两距离 —— 整簇放置时簇内也可能超出间距上限。
   */
  const spreadIfAdded = (day: Attraction[], cluster: Attraction[]) => {
    let maxD = 0
    for (const a of cluster) {
      for (const b of day) {
        const d = dist(a, b)
        if (d > maxD) maxD = d
      }
      for (let i = 0; i < cluster.length; i++) {
        for (let j = i + 1; j < cluster.length; j++) {
          const d = dist(cluster[i], cluster[j])
          if (d > maxD) maxD = d
        }
      }
    }
    return maxD
  }

  for (const cluster of ordered) {
    // 用户点选的点已经单独占位，不参与簇安置
    const fresh = cluster.filter((a) => !placed.has(a.id))
    if (!fresh.length) continue
    const clusterHours = fresh.reduce((s, x) => s + x.hours, 0)
    // 簇里只要有一个远郊点，这一簇就整体按远郊簇处理
    const clusterIsFar = fresh.some(isFar)
    let target = -1
    let bestScore = -Infinity

    for (let d = 0; d < days; d++) {
      const day = buckets[d]
      if (day.length + fresh.length > perDay) continue
      if (bucketsHours[d] + clusterHours > maxHours) continue
      // 远郊簇只能进远郊日，城区簇只能进城区日
      // 注意：空天允许放任何簇，否则远郊簇永远开不了新的一天
      if (day.length > 0 && clusterIsFar !== day.some(isFar)) continue
      const spread = spreadIfAdded(day, fresh)
      if (spread > MAX_SPREAD_KM) continue
      // 偏好：间距更小、当天更空
      let score = -spread * 2 - day.length * 1.5
      // 每天最多 2 个夜间点 —— 夜里能玩的地方有限，堆多了没有意义
      const dayEveningCount = day.filter((b) => b.bestTime === 'evening').length
      const clusterEveningCount = fresh.filter((b) => b.bestTime === 'evening').length
      if (dayEveningCount + clusterEveningCount > 1) continue
      score -= (dayEveningCount + clusterEveningCount) * 6
      if (score > bestScore) {
        bestScore = score
        target = d
      }
    }

    if (target >= 0) {
      buckets[target].push(...fresh)
      bucketsHours[target] += clusterHours
      for (const x of fresh) placed.add(x.id)
      continue
    }

    // 整簇放不下 → 拆成单点，逐点找位置
    for (const item of fresh) {
      const itemIsFar = isFar(item)
      let itemTarget = -1
      let itemScore = -Infinity
      for (let d = 0; d < days; d++) {
        const day = buckets[d]
        if (day.length + 1 > perDay) continue
        if (bucketsHours[d] + item.hours > maxHours) continue
        if (day.length > 0 && itemIsFar !== day.some(isFar)) continue
        // 每天最多 2 个夜间点
        const dayEvening = day.filter((b) => b.bestTime === 'evening').length
        if (item.bestTime === 'evening' && dayEvening >= 1) continue
        const spread = spreadIfAdded(day, [item])
        if (spread > MAX_SPREAD_KM) continue
        const score = -spread * 2 - day.length * 1.5
        if (score > itemScore) {
          itemScore = score
          itemTarget = d
        }
      }
      if (itemTarget >= 0) {
        buckets[itemTarget].push(item)
        bucketsHours[itemTarget] += item.hours
        placed.add(item.id)
      }
    }
  }

  // 兜底：还有没放下的点。
  // 关键原则：
  //  1) 远郊点绝不与市区点混在同一天
  //  2) 夜间点有配额上限，超出的直接舍弃 —— 宁可少排几个点，
  //     也不要给用户一份"连续三晚都在夜市"的荒唐行程
  const assigned = new Set(buckets.flat().map((a) => a.id))
  const eveningCap = days
  let eveningInBuckets = buckets
    .flat()
    .filter((a) => a.bestTime === 'evening').length

  for (const a of attractions) {
    if (assigned.has(a.id)) continue
    const far = isFar(a)
    // 夜间点超配额 → 除非是标志景点，否则舍弃
    if (a.bestTime === 'evening' && eveningInBuckets >= eveningCap && !a.signature) {
      continue
    }
    let target = -1
    let bestScore = -Infinity

    // 1) 同类型、还有容量的天里挑最合适的一天
    //    打分：优先点少的天（均衡分布），其次离得近的天
    for (let d = 0; d < days; d++) {
      if (buckets[d].length >= perDay) continue
      // 每天游玩时长上限 —— 兜底路径以前不查这一条，
      // 于是「紧凑暴走 11 小时 / 张弛有度 8.5 小时 / 悠闲慢游 6 小时」在真实输出里不成立
      if (bucketsHours[d] + a.hours > maxHours) continue
      if (buckets[d].length > 0 && buckets[d].some(isFar) !== far) continue
      // 每天最多 2 个夜间点
      if (
        a.bestTime === 'evening' &&
        buckets[d].filter((b) => b.bestTime === 'evening').length >= 1
      ) {
        continue
      }
      const dd = buckets[d].length
        ? Math.max(...buckets[d].map((b) => dist(a, b)))
        : 0
      const score = -buckets[d].length * 4 - dd
      if (score > bestScore) {
        bestScore = score
        target = d
      }
    }

    // 2) 没有合适的 → 找一个完全空的天（空天天然满足间距约束）
    if (target < 0) {
      for (let d = 0; d < days; d++) {
        if (buckets[d].length === 0 && a.hours <= maxHours) {
          target = d
          break
        }
      }
    }

    // 3) 还是没有合适的 → 放弃这个点。
    //    宁可少排一个景点，也不要把它硬塞进不合适的半天 ——
    //    行程质量比景点数量重要。
    if (target < 0) {
      continue
    }

    // 4) 最终校验：塞进去之后当天的最大间距仍要达标
    const day = buckets[target]
    const maxSpread = day.length
      ? Math.max(...day.map((b) => dist(a, b)))
      : 0
    if (maxSpread > MAX_SPREAD_KM) {
      continue
    }

    // 兜底也不能突破每天时长上限
    if (bucketsHours[target] + a.hours > maxHours) continue

    buckets[target].push(a)
    bucketsHours[target] += a.hours
    if (a.bestTime === 'evening') eveningInBuckets++
  }

  // 计算每桶重心
  const bucketsCenter: { x: number; y: number }[] = Array.from({ length: days }, () => ({
    x: 0,
    y: 0,
  }))
  for (let d = 0; d < days; d++) {
    const list = buckets[d]
    if (!list.length) continue
    bucketsCenter[d] = centerOf(list)
  }

  // 桶内排序：从离重心最远的点开始走最近邻路径，减少折返
  for (let d = 0; d < days; d++) {
    const list = buckets[d]
    if (list.length <= 1) continue
    const c = bucketsCenter[d]
    const pool = [...list]
    const orderedList: Attraction[] = []
    let cur = pool.reduce((best, a) => (dist(a, c) > dist(best, c) ? a : best))
    orderedList.push(cur)
    pool.splice(pool.indexOf(cur), 1)
    while (pool.length) {
      let bestIdx = 0
      let bestD = Infinity
      for (let i = 0; i < pool.length; i++) {
        const dd = dist(cur, pool[i])
        if (dd < bestD) {
          bestD = dd
          bestIdx = i
        }
      }
      cur = pool[bestIdx]
      orderedList.push(cur)
      pool.splice(bestIdx, 1)
    }
    buckets[d] = orderedList
  }

  const assignedAll = new Set(buckets.flat().map((a) => a.id))
  const missingMust = mustItems.filter((a) => !assignedAll.has(a.id))
  return { buckets, missingMust }
}

/**
 * 算出「用户点选的这批景点」最少需要几天
 *
 * **跑真实引擎**，不另写近似算法。天数从 1 递增，每次都完整跑一遍
 * generateTripInternal（含自动选点挤占、分天、时间轴、22:30 收工裁切），
 * 直到 picks.missing 为空。
 *
 * 之前试过两种更省事的写法，都不准：
 *   - 另写一套贪心装箱：漏了「每天最多 1 个夜间点」「远郊不与市区混排」
 *   - 只跑 distributeIntoDays + scheduleDay：漏了「自动选的点会先占容量」
 * 两种都会让建议天数比实际少 1-6 天，用户照着改天数还是排不下。
 *
 * 与榜单上的提示、以及行程里的警告用的是同一个函数，口径必然一致。
 */
export function minDaysForMustVisit(
  pack: CityPack,
  request: TripRequest,
  mustIds: string[]
): number {
  if (!mustIds.length) return 0
  for (let days = 1; days <= 15; days++) {
    // withSuggest=false：避免与下面的建议天数计算互相递归
    const plan = generateTripInternal(
      pack,
      { ...request, days, mustVisit: mustIds },
      false
    )
    if (!plan.picks || plan.picks.missing.length === 0) return days
  }
  return 15
}

/**
 * 为一天的景点安排时间轴。
 *
 * 排布策略：每个点先落在自己的"最佳时段"，若与已排的点冲突则向后顺延，
 * 同时强制避开饭点。若某天的点整体偏夜间（首个点就是夜生活类），
 * 则把这一天的起点提前，避免出现"整晚都在外面"的不合理行程。
 */
function scheduleDay(
  items: Attraction[],
  dayStartHour: number,
  pace: Pace,
  priorityIds: Set<string> = new Set(),
  /**
   * 相邻两点之间的路上时间（小时）
   *
   * 没有这个信息就按 0 算 —— 但那样界面会显示「10:00 结束 A、10:00 开始 B」，
   * 中间那 20 分钟地铁凭空消失，餐点还会排到你在出租车上吃午饭的时段里。
   */
  travelBetween?: (prev: Attraction, next: Attraction) => number
): { items: DayItem[]; hours: number } {
  if (!items.length) return { items: [], hours: 0 }

  // 分组：上午 → 全天 → 下午 → 晚间
  const slotOrder: TimeSlot[] = ['morning', 'any', 'afternoon', 'evening']
  const groups = new Map<TimeSlot, Attraction[]>()
  for (const t of slotOrder) groups.set(t, [])
  for (const a of items) {
    const key = groups.has(a.bestTime) ? a.bestTime : 'any'
    groups.get(key)!.push(a)
  }
  const queue: Attraction[] = []
  for (const t of slotOrder) {
    const g = groups.get(t)!
    g.sort((x, y) => {
      // 用户点选的点排前面 —— 否则可能被 22:30 收工线挤掉
      const px = priorityIds.has(x.id) ? 1 : 0
      const py = priorityIds.has(y.id) ? 1 : 0
      if (px !== py) return py - px
      return y.rating - x.rating
    })
    queue.push(...g)
  }

  // 起点自适应：若这天的点大多偏夜间，起点提前，避免"整晚都在外面"
  const eveningCount = queue.filter((a) => a.bestTime === 'evening').length
  const startHour =
    eveningCount === queue.length
      ? 15.0
      : eveningCount > queue.length / 2
        ? 13.0
        : dayStartHour

  const result: DayItem[] = []
  // cursor = 上一个排好的点的结束时刻；lastScheduled = 上一个排好的点
  let cursor = startHour
  let lastScheduled: Attraction | undefined

  // 逐个排点。夜间点不按绝对时刻（19:00）钉死，而是排在当天序列的靠后位置，
  // 否则一天全是夜生活时会从 19:00 开始，行程显得荒唐。
  const n = queue.length
  for (let i = 0; i < n; i++) {
    const a = queue[i]
    const isEvening = a.bestTime === 'evening'

    // 到达这个点的时间：上一个点结束 → 路上花多久 → 饭点避让
    // 路上时间是真实存在的，不能被时间轴吃掉 ——
    // 否则界面会显示「10:00 结束 A、10:00 开始 B」，中间那段地铁凭空消失。
    let arrive = cursor
    if (lastScheduled) {
      const travel = travelBetween ? travelBetween(lastScheduled, a) : 0
      arrive = cursor + travel
      if (pace === 'packed') arrive += 0.3
    }
    // 午饭 / 晚饭时间：赶路撞上饭点，就等吃完再走下一站
    if (arrive >= 11.5 && arrive < 13) arrive = 13
    if (arrive >= 17.5 && arrive < 18.8) arrive = 18.8

    // 夜间点：排在当天 60%-80% 的位置处开始
    let start: number
    if (isEvening) {
      const span = Math.max(2.5, 22.5 - startHour)
      const offset = span * (0.58 + 0.2 * ((i - Math.floor(n * 0.6)) / Math.max(1, n)))
      start = Math.max(arrive, startHour + offset)
    } else {
      start = Math.max(arrive, SLOT_START[a.bestTime])
    }
    // 晚间点最晚 21:00 开始，避免排到凌晨。
    // 注意不能直接把 start 压回 21 —— 若 arrive（到达这个点的时刻）已经过了 21 点，
    // 压回去会让这个点的开始时间早于到达时刻，时间轴倒流。
    // 所以钳位之后还要抬回 arrive，让后面的 22.5 收工检查去决定跳过还是截断。
    if (isEvening && start > 21) start = Math.max(arrive, 21)
    // 一天最晚 22:30 结束
    if (start + a.hours > 22.5) {
      const remaining = 22.5 - start
      if (remaining < 0.5) continue
      const end = start + Math.min(a.hours, remaining)
      result.push({
        attraction: a,
        startTime: fmtTime(start),
        endTime: fmtTime(end),
      })
      cursor = end
      lastScheduled = a
      continue
    }
    const end = start + a.hours
    result.push({
      attraction: a,
      startTime: fmtTime(start),
      endTime: fmtTime(end),
    })
    cursor = end
    lastScheduled = a
  }

  const hours = result.length
    ? parseTime(result[result.length - 1].endTime) - parseTime(result[0].startTime)
    : 0
  return { items: result, hours }
}

/** 根据总预算与风格推导住宿档次 */
function deriveTier(budgetPerNight: number): HotelTier {
  if (budgetPerNight < 320) return 'budget'
  if (budgetPerNight < 780) return 'comfort'
  return 'premium'
}

/**
 * 估算往返大交通。
 *
 * 依据真实直线距离分档：
 *   境内 400km 以内 → 高铁为主
 *   境内 400-1000km → 高铁与直飞各有优劣，按实际说明
 *   境内 1000km 以上 → 直飞为主
 *   境外 → 国际航班，按距离给出时长与票价区间
 */
function estimateLongDistance(
  pack: CityPack,
  request: TripRequest
): {
  arrival: TripPlan['transitPlan']['arrival']
  departure: TripPlan['transitPlan']['departure']
} {
  const overseas = pack.city.overseas
  const origin = findOrigin(request.origin)
  const coords = pack.city.coordinates
  const km =
    origin && coords ? Math.round(haversine(origin.coordinates, coords)) : null

  if (overseas) {
    const est = km
      ? km < 2000
        ? 2800
        : km < 5000
          ? 3600
          : km < 9000
            ? 4600
            : 6200
      : 3200
    const cost = Math.round((est * request.travelers * 1.12) / 100) * 100
    const dur = km
      ? km < 2500
        ? '约 4-6 小时（含中转）'
        : km < 6000
          ? '约 6-9 小时'
          : '约 9-13 小时'
      : '约 5-11 小时（视航线）'
    return {
      arrival: {
        mode: '国际航班',
        cost,
        duration: dur,
        note: request.origin
          ? `从${request.origin}出发，直线约 ${km?.toLocaleString()} km。往返机票建议提前 6-8 周预订，旺季（春节 / 国庆 / 寒暑假）更早`
          : '国际航班建议提前 6-8 周预订，越早越便宜',
      },
      departure: {
        mode: '国际航班',
        cost: 0,
        duration: '按航班时刻',
        note: '预留 3 小时到机场，国际航班提前 3 小时值机；跨时区航班注意落地日期',
      },
    }
  }

  // 境内：按距离分档
  const distance = km ?? 800
  const byStyle: Record<BudgetStyle, [number, number]> = {
    thrifty: [480, 900],
    balanced: [880, 1600],
    premium: [1700, 3400],
  }
  const [lo, hi] = byStyle[request.style]
  // 距离越远票价越高，在风格区间上浮
  const distFactor = 1 + Math.min(1.2, Math.max(0, (distance - 400) / 2600))
  const mid = Math.round((((lo + hi) / 2) * distFactor * request.travelers) / 50) * 50

  let mode: string
  let duration: string
  let note: string

  if (distance < 400) {
    mode = '高铁 / 城际动车'
    duration = '约 1.5-3 小时'
    note = `直线 ${distance.toLocaleString()} km，高铁班次密集。提前 15 天买票有折扣，临近出发也常有特价。直达优先，别选需要中转的车次`
  } else if (distance < 800) {
    // 阈值必须与 fare.ts 的排序阈值一致（都是 800km）——
    // 否则同一张卡片上会出现「高铁为主，直飞为辅」但票价列表第一条是飞机
    mode = '高铁为主，直飞为辅'
    duration = '约 3-6 小时'
    note = `直线 ${distance.toLocaleString()} km。高铁约 4-5 小时且市中心直达；直飞约 1.5 小时但要算上往返机场与提前值机。带行李或赶时间选高铁，纯粹省时间选直飞`
  } else {
    mode = '直飞航班为主'
    duration = '约 2-3.5 小时'
    note = `直线 ${distance.toLocaleString()} km，高铁普遍在 6 小时以上，除非票价极低否则不划算。直飞记得留足 2 小时到机场，早班机比晚班机更稳`
  }

  return {
    arrival: {
      mode,
      cost: mid,
      duration,
      note,
    },
    departure: {
      mode: '返程同上',
      cost: 0,
      duration: '按车次 / 航班时刻',
      note: '最后一天的行程按返程时间倒推，落地前 3 小时结束游玩',
    },
  }
}

/**
 * 生成完整攻略
 *
 * withSuggest=false 时不计算「建议天数」——
 * 供 minDaysForMustVisit 内部调用，避免两者互相递归。
 */
function generateTripInternal(
  pack: CityPack,
  request: TripRequest,
  withSuggest: boolean
): TripPlan {
  const { city, attractions, hotels, transit } = pack
  // 外部输入统一在引擎边界上归一化（理由见 VALID_STYLES 的注释）：
  //   - style / pace：查表取不到会让硬约束静默失效
  //   - days：必须取整 —— Array.from({length: 3.5}) 只有 3 个元素，
  //     但循环条件是 d < days 会走到下标 3，buckets[3] 是 undefined，直接抛错白屏
  //   - travelers / budget：0.5 人、1.5 元这类退化值会让「高出 257900%」这种文案出现
  const style: BudgetStyle = VALID_STYLES.has(request.style) ? request.style : 'balanced'
  const pace: Pace = VALID_PACES.has(request.pace) ? request.pace : 'balanced'
  const days = Number.isFinite(request.days)
    ? Math.max(1, Math.min(15, Math.round(request.days)))
    : 1
  // 预算下限对齐表单滑块（1000 元）——
  // 否则会出现「比你设的 2 元高出 255500%」这种失去意义的文案
  const budget = Number.isFinite(request.budget)
    ? Math.max(1000, Math.round(request.budget))
    : 1000
  const travelers = Number.isFinite(request.travelers)
    ? Math.max(1, Math.min(10, Math.round(request.travelers)))
    : 1
  request = { ...request, style, pace, days, budget, travelers }
  // 出发日期（缺省或非法就不标真实日期）
  // startDate 来自 URL / 表单，是外部输入，引擎边界上再校验一次
  const startDate =
    request.startDate && parseISO(request.startDate) ? request.startDate : undefined

  // 用户在「景点好评榜」里点选的景点：优先安排，且不参与自动选点的名额竞争
  const mustIds = new Set(request.mustVisit ?? [])
  const mustItems = attractions.filter((a) => mustIds.has(a.id))
  const onlyMust = request.onlyMustVisit === true && mustItems.length > 0
  // 自动选点的候选：排除用户点选的点（它们单独优先占位）
  const autoCandidates = onlyMust ? [] : attractions.filter((a) => !mustIds.has(a.id))

  // 1) 打分
  const scored = autoCandidates
    .map((a) => ({
      a,
      s: scoreAttraction(a, request.prefs, city, request.month, request.rainy === true),
    }))
    .sort((x, y) => y.s - x.s)

  // 选点：按簇来选，避免远郊点被选中却和市区点挤在同一天
  //  1) 先把全部景点聚成地理簇
  //  2) 远郊簇（离市中心 >18km）优先保留，每个远郊簇独占一天
  //  3) 剩余天数用市区簇按分数填充
  const allClusters = clusterAttractions(autoCandidates)
  const scoreOf = new Map(scored.map((x) => [x.a.id, x.s]))
  const clusterScore = (c: Attraction[]) =>
    c.reduce((s, a) => s + (scoreOf.get(a.id) ?? 0), 0) / c.length

  const farClusters = allClusters.filter((c) => c.some(isFar))
  const urbanClusters = allClusters.filter((c) => !c.some(isFar))

  // 远郊簇：按平均分排序，最多占用 ceil(days/2) 天
  farClusters.sort((a, b) => clusterScore(b) - clusterScore(a))
  // 远郊点会独占一整天，所以只有在天数有富余时才值得安排：
  // 至少要留出 1 天给市区，不能把行程全变成郊外出行
  const maxFarDays = Math.max(0, Math.min(farClusters.length, days - 1))
  // 远郊簇之间若彼此也隔得很远（>25km），只保留分最高的那个 ——
  // 都江堰和黄黄龙溪同一天要跑 60km 冤枉路，不如只去一个
  const usedFarClusters: Attraction[][] = []
  for (const c of farClusters) {
    if (usedFarClusters.length >= maxFarDays) break
    const farApart = usedFarClusters.some((prev) => dist(centerOf(prev), centerOf(c)) > 25)
    if (farApart) continue
    usedFarClusters.push(c)
  }
  let farDaysUsed = usedFarClusters.length
  // 市区簇：按平均分排序，按剩余天数的容量逐个填充
  urbanClusters.sort((a, b) => clusterScore(b) - clusterScore(a))
  const urbanCapacity = (days - farDaysUsed) * SPOTS_PER_DAY[request.pace]
  const picked: Attraction[] = []
  let urbanCount = 0
  // 每天最多安排 2 个夜间点 —— 夜里能玩的地方有限，堆多了行程会很荒唐
  let eveningUsed = 0
  const eveningQuota = days
  // 夜间点总数不超过白天点 —— 行程主体必须是白天能逛的地方
  const eveningRatioCap = Math.ceil(urbanCapacity / 2)

  // 簇内排序：按评分降序，同分时优先非夜间点
  const rankInCluster = (a: Attraction, b: Attraction) => {
    const byRating = b.rating - a.rating
    if (byRating !== 0) return byRating
    if (a.bestTime === 'evening' && b.bestTime !== 'evening') return 1
    if (b.bestTime === 'evening' && a.bestTime !== 'evening') return -1
    return 0
  }

  for (const c of urbanClusters) {
    if (urbanCount >= urbanCapacity) break
    const sorted = [...c].sort(rankInCluster)
    const hasSignature = c.some((a) => a.signature)

    // 先尝试整簇收下
    const clusterEvening = c.filter((a) => a.bestTime === 'evening').length
    const wholeFits =
      urbanCount + c.length <= urbanCapacity &&
      eveningUsed + clusterEvening <= eveningQuota &&
      eveningUsed + clusterEvening <= eveningRatioCap

    if (wholeFits || (hasSignature && urbanCount < urbanCapacity)) {
      picked.push(...sorted)
      urbanCount += sorted.length
      eveningUsed += sorted.filter((a) => a.bestTime === 'evening').length
      continue
    }

    // 整簇收不下 → 逐个取，直到容量或夜间配额用完
    for (const item of sorted) {
      if (urbanCount >= urbanCapacity) break
      if (item.bestTime === 'evening') {
        if (eveningUsed >= eveningQuota) continue
        if (eveningUsed >= eveningRatioCap) continue
      }
      picked.push(item)
      urbanCount++
      if (item.bestTime === 'evening') eveningUsed++
    }
  }

  // 远郊簇整体加入
  for (const c of usedFarClusters) picked.push(...c)

  // 标志性景点保底
  // 远郊的标志景点若不在已选远郊簇里，不强行补 —— 否则会挤掉市区行程。
  // 远郊天数还有富余时才补。
  const pickedIds = new Set(picked.map((a) => a.id))
  const spareFarDays = maxFarDays - farDaysUsed
  const farSignatures = autoCandidates.filter(
    (a) => a.signature && isFar(a) && !pickedIds.has(a.id)
  )
  if (spareFarDays > 0 && farSignatures.length) {
    const extra = farSignatures.slice(0, spareFarDays)
    for (const s of extra) picked.push(s)
    farDaysUsed += 1
  }
  for (const s of autoCandidates.filter((a) => a.signature && !isFar(a))) {
    if (!picked.includes(s)) picked.push(s)
  }

  // 用户点选的点最优先，其余景点围着它们编排
  const finalPicked = [...mustItems, ...picked]

  // 2) 分天：用户点选的点优先占位
  const { buckets, missingMust: noRoom } = distributeIntoDays(
    finalPicked,
    days,
    request.pace,
    mustIds
  )

  // 3) 排时间轴 + 算交通
  //
  // 分两趟：第一趟只排景点，第二趟才挂餐点。
  // 原因是餐点要知道「全行程的片区」——空白天没有景点可参考，
  // 得用整趟行程的片区兜底，否则空白天会一张嘴都报不出来。
  const dayPlans: DayPlan[] = []
  let totalTransitCost = 0
  let totalTicketCost = 0

  const dayDrafts: {
    items: DayItem[]
    transitCost: number
    ticketCost: number
    minutesTotal: number
  }[] = []

  for (let d = 0; d < days; d++) {
    const raw = buckets[d] ?? []
    // 路上时间：排时间轴和算交通费用的是同一份，不能各算各的
    const travelMemo = new Map<string, number>()
    const travelBetween = (prev: Attraction, next: Attraction): number => {
      const key = `${prev.id}>${next.id}`
      const hit = travelMemo.get(key)
      if (hit !== undefined) return hit / 60
      const m = pickMode(dist(prev, next), transit, { hurry: request.pace === 'packed' })
      travelMemo.set(key, m.minutes)
      return m.minutes / 60
    }
    const { items } = scheduleDay(raw, 9.0, request.pace, mustIds, travelBetween)
    for (const it of items) {
      if (mustIds.has(it.attraction.id)) it.picked = true
    }

    let transitCost = 0
    let ticketCost = 0
    let prev: Attraction | undefined
    let minutesTotal = 0

    for (const it of items) {
      ticketCost += it.attraction.ticket
      if (prev) {
        const dkm = dist(prev, it.attraction)
        const m = pickMode(dkm, transit, { hurry: request.pace === 'packed' })
        it.transit = {
          mode: m.mode,
          minutes: m.minutes,
          cost: m.cost,
          distanceKm: Math.round(dkm * 10) / 10,
          note: m.option.note,
        }
        transitCost += m.cost
        minutesTotal += m.minutes
      }
      prev = it.attraction
    }

    totalTransitCost += transitCost
    totalTicketCost += ticketCost
    dayDrafts.push({ items, transitCost, ticketCost, minutesTotal })
  }

  // 全行程片区：空白天选餐的兜底依据
  const tripZones = [
    ...new Set(dayDrafts.flatMap((d) => d.items.map((i) => i.attraction.zone))),
  ]
  // 整座城市都没有餐厅数据时，餐饮退回按风格估算，别让预算凭空少一块
  const hasFoodData = pack.foods.length > 0
  let totalFoodCost = 0
  // 这趟行程已经用过的菜名 —— 避免三天都吃同一家
  const usedFoods: string[] = []

  for (let d = 0; d < days; d++) {
    const draft = dayDrafts[d]
    const { items, transitCost, ticketCost, minutesTotal } = draft
    // 这一天对应的真实日期
    const dayDate = startDate ? addDays(startDate, d) : ''

    // 用**实际排出的**时长，不是景点的名义时长 ——
    // 被 22:30 收工线截断的景点只玩了实际那么久，按名义算会虚高（实测最多 3.07h），
    // 还会误触发「一天超过 10 小时」的体力透支告警
    const playHours = items.reduce(
      (s, i) => s + (parseTime(i.endTime) - parseTime(i.startTime)),
      0
    )
    const dayHours = playHours + minutesTotal / 60
    const zones = [...new Set(items.map((i) => i.attraction.zone))]

    // 餐点：按当天片区挑店，落在当天的真实空档里
    // 空档 = 没在参观、也没在路上 —— 只避开参观时段的话，
    // 午饭会被排到「正坐着地铁从 A 赶去 B」的那 20 分钟里（实测 166 处重叠）。
    const busy: { start: number; end: number }[] = items.map((it) => ({
      start: parseTime(it.startTime),
      end: parseTime(it.endTime),
    }))
    for (let i = 1; i < items.length; i++) {
      const tr = items[i].transit
      if (!tr || tr.minutes <= 0) continue
      const from = parseTime(items[i - 1].endTime)
      busy.push({ start: from, end: from + tr.minutes / 60 })
    }
    const { meals, slotCosts } = buildMeals(pack, {
      zones,
      tripZones,
      busy,
      usedFoods,
    })
    for (const m of meals) usedFoods.push(m.name)
    // 排不进日程的餐次也要计钱 —— 那顿饭你照样得吃。
    // 只按「排出来的」算，预算会凭空少几百块，超支告警也跟着失真。
    const foodCost = hasFoodData
      ? (slotCosts.breakfast + slotCosts.lunch + slotCosts.dinner) *
        Math.max(1, request.travelers)
      : FOOD_PER_DAY[request.style] * request.travelers
    totalFoodCost += foodCost

    dayPlans.push({
      day: d + 1,
      dateLabel: startDate
        ? `第 ${d + 1} 天 · ${formatCN(dayDate)}（${weekdayCN(dayDate)}）`
        : `第 ${d + 1} 天`,
      title: zones.length ? zones.join(' · ') : '自由活动',
      items,
      meals,
      mealSlotCosts: slotCosts,
      // 按日期挂载，不是按数组下标 ——
      // 下标挂载在天气少一天时会整体错位（11 月 30 日显示成 12 月 1 日的天气，还不报错）
      weather: request.dailyWeather?.find((w) => w.date === dayDate),
      transitCost,
      ticketCost,
      foodCost,
      hours: Math.round(dayHours * 10) / 10,
      zone: zones[0] ?? '',
      note: buildDayNote(items, request.pace, meals, hasFoodData),
    })
  }

  // 4) 预算
  const ratio = BUDGET_RATIO[request.style]
  const nights = Math.max(1, days - 1)
  const stayBudget = request.budget * ratio.stay
  const budgetPerNight = stayBudget / nights
  const targetTier = deriveTier(budgetPerNight)

  // 5) 住宿推荐
  const centroid = computeCentroid(dayPlans.flatMap((d) => d.items.map((i) => i.attraction)))
  const ranked = hotels
    .map((h) => ({ h, s: scoreHotel(h, targetTier, centroid, nights, budgetPerNight) }))
    .sort((a, b) => b.s - a.s)
  const best = ranked[0]?.h
  const alternatives = ranked.slice(1, 4).map((r) => r.h)

  const allItems = dayPlans.flatMap((d) => d.items)
  const lodging: LodgingSuggestion = best
    ? {
        hotel: best,
        reason: buildLodgingReason(best, targetTier, centroid, nights),
        avgDistance:
          Math.round(
            (allItems.reduce((s, i) => s + dist(best, i.attraction), 0) /
              Math.max(1, allItems.length)) *
              10
          ) / 10,
        nights,
        totalCost: Math.round(best.price * nights),
        alternatives,
      }
    : {
        hotel: {} as Hotel,
        reason: '暂无住宿数据',
        avgDistance: 0,
        nights,
        totalCost: 0,
        alternatives: [],
      }

  // 6) 预算明细
  const transitBudget = request.includeTransport
    ? request.budget * ratio.transit
    : request.budget * ratio.transit * 0.35
  const budgetItems: BudgetItem[] = [
    {
      key: 'stay',
      label: '住宿',
      amount: Math.round(stayBudget),
      ratio: ratio.stay,
      detail: `${nights} 晚 × ${best ? best.price : 0} 元（${best ? best.zone : ''}）`,
    },
    {
      key: 'transit',
      label: request.includeTransport ? '交通（含往返大交通）' : '交通（市内为主）',
      amount: Math.round(transitBudget),
      ratio: ratio.transit,
      detail: request.includeTransport
        ? `往返大交通 + 市内交通，预计 ${Math.round(totalTransitCost / Math.max(1, days))} 元/天市内`
        : `市内交通实测约 ${Math.round(totalTransitCost)} 元`,
    },
    {
      key: 'food',
      label: '餐饮',
      amount: Math.round(request.budget * ratio.food),
      ratio: ratio.food,
      detail: hasFoodData
        ? `按当天三餐人均实测（排不进日程的餐次按均价计），日均约 ${Math.round(totalFoodCost / Math.max(1, days))} 元（全程约 ${totalFoodCost} 元）`
        : `约 ${FOOD_PER_DAY[request.style] * request.travelers} 元/天 × ${days} 天`,
    },
    {
      key: 'ticket',
      label: '门票',
      amount: Math.round(request.budget * ratio.ticket),
      ratio: ratio.ticket,
      detail: `行程内景点门票合计约 ${totalTicketCost} 元`,
    },
    {
      key: 'other',
      label: '其他（购物 / 应急 / 小吃）',
      amount: Math.round(request.budget * ratio.other),
      ratio: ratio.other,
      detail: '留出弹性，实地再决定',
    },
  ]

  // 7) 大交通
  const { arrival, departure } = estimateLongDistance(pack, request)
  const cityTransitOption =
    transit.find((t) => t.mode === 'metro') ?? transit.find((t) => t.mode === 'bus') ?? transit[0]

  // 8) 实测估算
  // 往返大交通必须算进来：预算明细里「交通」那一项本来就写着「含往返大交通」，
  // 拿一个不含大交通的数去跟含大交通的预算比，超支告警就是摆设
  // （实测：成都 2 人 premium，真实约 9500 元，预算 6000 元却一声不吭）。
  const longDistanceCost = request.includeTransport ? arrival.cost : 0
  const estimatedCost =
    lodging.totalCost +
    Math.round(totalTransitCost) +
    totalFoodCost +
    totalTicketCost +
    longDistanceCost

  const bestWindow = computeBestWindow(city, request.month)

  const tips = buildTips(pack, request, best, dayPlans)
  const warnings = buildWarnings(pack, request, dayPlans)
  // 实测总价明显超预算时要说实话 —— 之前餐饮用风格常量，看不出超支
  if (estimatedCost > request.budget * 1.12) {
    // 预算为 0 时百分比没有意义（会算出 Infinity%）
    const over = request.budget > 0
      ? `，比你设的 ${request.budget.toLocaleString()} 元高出 ${Math.round(
          ((estimatedCost - request.budget) / request.budget) * 100
        )}%`
      : ''
    warnings.push(
      `按行程实测估算共 ${estimatedCost.toLocaleString()} 元（含往返大交通 ${longDistanceCost.toLocaleString()} 元）${over}。可以砍掉几天的门票、换更便宜的住宿，或把人数调小`
    )
  }

  // 点选结果：哪些排进去了、哪些没排进去
  const placedIds = new Set(dayPlans.flatMap((d) => d.items.map((i) => i.attraction.id)))
  const missingMust = mustItems.filter((a) => !placedIds.has(a.id))
  const picks: PickResult | undefined = mustItems.length
    ? {
        selected: mustItems.map((a) => a.id),
        placed: mustItems.filter((a) => placedIds.has(a.id)).map((a) => a.id),
        missing: missingMust.map((a) => a.id),
      }
    : undefined
  if (missingMust.length) {
    const need = withSuggest
      ? minDaysForMustVisit(
          pack,
          request,
          mustItems.map((a) => a.id)
        )
      : 0
    // 区分两种排不进去的原因
    const noRoomIds = new Set(noRoom.map((a) => a.id))
    const timeCut = missingMust.filter((a) => !noRoomIds.has(a.id))
    const blocked = missingMust.filter((a) => noRoomIds.has(a.id))
    const reasons: string[] = []
    if (blocked.length) {
      reasons.push(`${blocked.map((a) => a.name).join('、')} 受每天游玩时长和同日直线距离限制，放不进任何一天`)
    }
    if (timeCut.length) {
      reasons.push(`${timeCut.map((a) => a.name).join('、')} 排进了当天，但 22:30 收工线前塞不下`)
    }
    warnings.push(
      `你点的景点没能全部排进这 ${days} 天（${reasons.join('；')}）。` +
        (need > 0 ? `建议把天数调到 ${need} 天，` : '建议增加天数，') +
        `或少选 ${missingMust.length} 个景点。`
    )
  }

  return {
    // startDate 用清洗后的值：原来把原始值又塞了回去，
    // 于是日历导出能拿到 "not-a-date" 这种非法日期，产出 notadateT090000 这种非法时间戳
    request: { ...request, days, startDate },
    cityName: city.name,
    days: dayPlans,
    lodging,
    budgetItems,
    totalBudget: request.budget,
    perDayBudget: Math.round(request.budget / days),
    perPersonBudget: Math.round(request.budget / Math.max(1, request.travelers)),
    estimatedCost,
    transitPlan: {
      arrival,
      departure,
      cityTransit: {
        mode: cityTransitOption.mode,
        label:
          cityTransitOption.mode === 'metro'
            ? '地铁为主'
            : cityTransitOption.mode === 'bus'
              ? '公交为主'
              : '混合出行',
        dailyCost: cityTransitOption.dailyCost * request.travelers,
        note: cityTransitOption.note,
      },
    },
    tips,
    warnings,
    bestWindow,
    picks,
  }
}

/** 生成完整攻略 */
export function generateTrip(pack: CityPack, request: TripRequest): TripPlan {
  return generateTripInternal(pack, request, true)
}

function computeCentroid(list: Attraction[]): { x: number; y: number } {
  if (!list.length) return { x: 0, y: 0 }
  return {
    x: list.reduce((s, a) => s + a.x, 0) / list.length,
    y: list.reduce((s, a) => s + a.y, 0) / list.length,
  }
}

function buildDayNote(
  items: DayItem[],
  pace: Pace,
  meals?: MealItem[],
  /** 这座城市有没有餐厅数据 —— 没有的话就不该出现任何餐点提示 */
  hasFoodData = true
): string {
  if (!items.length) {
    return '留白日：适合睡懒觉、在周边小范围 city walk，或用来补前面没逛完的点'
  }
  const evening = items.find((i) => i.attraction.bestTime === 'evening')
  const indoor = items.find(
    (i) => i.attraction.indoor || i.attraction.tags.includes('indoor')
  )
  const notes: string[] = []
  if (pace === 'packed') notes.push('今天排得满，注意每 2 小时坐下来喝口水')
  if (evening) notes.push(`晚间安排「${evening.attraction.name}」，别错过最佳时段`)
  if (indoor) notes.push(`「${indoor.attraction.name}」是室内，雨天或暴晒天可作备选`)
  if (items.length >= 4) notes.push('同一天点位偏多，删掉一个也能让体验变好')
  const hasEveningFood = items.some(
    (i) => i.attraction.tags.includes('food') && i.attraction.bestTime === 'evening'
  )
  if (hasEveningFood) notes.push('晚上还有美食街 / 夜市，吃完饭能再逛一轮吃小吃')
  if (hasFoodData && meals) {
    if (meals.length === 0) {
      notes.push('这天行程排得太满，三餐都挤不进去，路上自己解决（餐饮费已按三餐均价计入预算）')
    } else if (meals.length < 3) {
      notes.push(
        `这天排得太满，只塞得下 ${meals.length} 餐，中间可以随时补点小吃（其余餐次已按均价计入预算）`
      )
    }
  }
  return notes.join('；') || '按推荐顺序走即可'
}

function buildLodgingReason(
  hotel: Hotel,
  tier: HotelTier,
  centroid: { x: number; y: number },
  nights: number
): string {
  const d = dist(hotel, centroid)
  const tierName = { budget: '经济型', comfort: '舒适型', premium: '高端型' }[tier]
  const parts: string[] = [
    `${hotel.zone}片区，${tierName}档位约 ${hotel.price} 元/晚`,
    `距离本次行程核心区域约 ${d.toFixed(1)} km`,
  ]
  if (hotel.near.length) parts.push(`紧邻${hotel.near.slice(0, 2).join('、')}`)
  if (nights >= 4) {
    parts.push('连住多晚，位置优势会被放大，建议直接订可免费取消的房型')
  }
  return parts.join('，')
}

function buildTips(
  pack: CityPack,
  request: TripRequest,
  hotel: Hotel | undefined,
  days: DayPlan[]
): string[] {
  const tips: string[] = []
  tips.push(pack.city.transitNote)
  if (hotel) {
    tips.push(
      `住宿建议落在${hotel.zone}：这是本次行程景点的几何中心，白天往返省下的时间比房价差更值钱`
    )
  }
  const needBooking = days
    .flatMap((d) => d.items)
    .filter((i) => i.attraction.needBooking)
  if (needBooking.length) {
    tips.push(
      `需要提前预约：${needBooking.map((i) => i.attraction.name).join('、')}，出发前 1-3 天在官方渠道预约`
    )
  }
  if (needBooking.length >= 2) {
    tips.push('预约点位较多，行程已按预约难度排好顺序，不要随意调整日期顺序')
  }
  tips.push(
    `人均预算约 ${Math.round(request.budget / request.travelers)} 元，实际花费按「住宿 ${hotel?.price ?? 0}×${Math.max(1, request.days - 1)} 晚 + 门票 + 三餐」倒推`
  )
  const rainy = days
    .flatMap((d) => d.items)
    .filter((i) => i.attraction.indoor || i.attraction.tags.includes('indoor')).length
  if (rainy >= 2) tips.push('行程里含多个室内点，遇到雨天可以调换顺序，把室内的挪到雨天')
  return tips
}

function buildWarnings(
  pack: CityPack,
  request: TripRequest,
  days: DayPlan[]
): string[] {
  const w: string[] = []
  if (pack.city.overseas) {
    w.push(`签证提醒：${pack.city.visa}`)
  }
  if (!pack.city.bestMonths.includes(request.month)) {
    w.push(
      `${request.month} 月不在${pack.city.name}的最佳月份内，旺季价格与客流都会上升，户外项目体验可能打折`
    )
  }
  const heavy = days.filter((d) => d.hours > 10)
  if (heavy.length) {
    w.push(
      `有 ${heavy.length} 天安排超过 10 小时，属于体力透支区间，带娃或长辈同行建议删减`
    )
  }
  const booking = days.flatMap((d) => d.items).filter((i) => i.attraction.needBooking)
  if (booking.length >= 3) w.push('预约点位偏多，临时改期容易翻车，务必提前订好')
  if (request.travelers >= 5) {
    w.push('人数较多，热门餐厅与景点建议提前锁定或分批行动')
  }
  return w
}

function computeBestWindow(city: CityPack['city'], month: number): string {
  const names = [
    '',
    '1月',
    '2月',
    '3月',
    '4月',
    '5月',
    '6月',
    '7月',
    '8月',
    '9月',
    '10月',
    '11月',
    '12月',
  ]
  const best = city.bestMonths
  if (best.includes(month)) {
    return `${names[month]}属于${city.name}的黄金期，本行程的户外点位体验最佳`
  }
  const sorted = [...best].sort((a, b) => Math.abs(a - month) - Math.abs(b - month))
  const nearest = sorted[0]
  return `当前选择${names[month]}，${city.name}的最佳月份是 ${best
    .map((m) => names[m])
    .join('、')}；如果日期可调，优先挪到 ${names[nearest]}`
}
