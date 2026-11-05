/**
 * 餐饮挂进日程 —— 按当天片区挑餐厅，按真实人均价算钱，按真实空档排时间
 *
 * 三个原则：
 *   1) **按片区挑**：优先当天会走到的片区（zone），而不是全城随便报三个菜名。
 *      片区名是「东关 / 回民街」这种复合写法，所以要分词 + 双向子串匹配；
 *      标着「全城」的餐厅对任何片区都成立，但优先级低于正好在那一片的店。
 *   2) **按实测算钱**：人均价直接取城市数据里写明的价格区间中值，
 *      当日餐饮 = 三餐人均之和 × 人数。不用「按风格拍脑袋的日均常量」那种糊弄数。
 *   3) **按真实空档排时间**：餐点必须落在当天景点之间的空档里，
 *      否则界面会出现「正在参观博物馆的同时在吃火锅」。
 */

import type { CityPack } from '../data/types'

/** 餐次 */
export type MealSlot = 'breakfast' | 'lunch' | 'dinner'

export const MEAL_LABELS: Record<MealSlot, string> = {
  breakfast: '早餐',
  lunch: '午餐',
  dinner: '晚餐',
}

/** 一顿饭 */
export interface MealItem {
  slot: MealSlot
  /** 餐次中文名 */
  label: string
  /** 菜名 / 店名 */
  name: string
  /** 一句话介绍 */
  desc: string
  /** 所在片区 */
  zone: string
  /** 人均（元） */
  cost: number
  /** 原始价格文案，如「人均 15-20 元」 */
  priceText: string
  /** 开始时间 HH:MM */
  startTime: string
  /** 结束时间 HH:MM */
  endTime: string
}

/** 时间区间（小时，24 小时制浮点） */
interface Interval {
  start: number
  end: number
}

/** 当天的上下文（由引擎传入，meals.ts 不认识引擎内部结构） */
export interface MealContext {
  /** 当天景点的片区 */
  zones: string[]
  /** 整趟行程的片区（空白天兜底用） */
  tripZones: string[]
  /** 当天景点占用的时间段 */
  busy: Interval[]
  /** 这趟行程里已经吃过的菜名（可重复；重复次数用来做均衡分配） */
  usedFoods: string[]
}

/* ------------------------------------------------------------------ *
 * 价格解析
 * ------------------------------------------------------------------ */

/** 从「人均 15-20 元」「10-15 元」这类文案里抠出价格区间 */
export function parsePriceText(text?: string): { low: number; high: number } | null {
  if (!text) return null
  const nums = text.match(/\d+(?:\.\d+)?/g)
  if (!nums || !nums.length) return null
  const low = Number(nums[0])
  const high = nums.length > 1 ? Number(nums[1]) : low
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null
  return low <= high ? { low, high } : { low: high, high: low }
}

/* ------------------------------------------------------------------ *
 * 片区匹配
 * ------------------------------------------------------------------ */

/** 把「东关 / 回民街」「城北 · 熊猫基地」拆成可比较的词 */
function tokenize(zone: string): string[] {
  return zone
    .split(/[/·、,，\s]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
}

/** 两个片区词是否指向同一个地方（双向子串，长词包含短词即算命中） */
function samePlace(a: string, b: string): boolean {
  if (a === b) return true
  if (a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a))) return true
  return false
}

/** 「全城」「全市」这类标记 —— 对任何片区都成立，但优先级低 */
const CITYWIDE = /(全城|全市|遍地)/

/**
 * 给某个菜名算「跟当天片区有多合」的分数
 * 命中越多分越高，完全不沾边就是 0
 */
function zoneAffinity(foodZone: string | undefined, dayZones: string[]): number {
  if (!foodZone) return 0
  if (CITYWIDE.test(foodZone)) return 5
  const fTokens = tokenize(foodZone)
  if (!fTokens.length) return 0
  let score = 0
  for (const dz of dayZones) {
    const dTokens = tokenize(dz)
    for (const ft of fTokens) {
      for (const dt of dTokens) {
        if (samePlace(ft, dt)) {
          score += 10
          break
        }
      }
    }
  }
  return score
}

/* ------------------------------------------------------------------ *
 * 选餐
 * ------------------------------------------------------------------ */

/** 正餐类关键词：这类不适合当早餐 */
const DINNER_ONLY = /(火锅|烤肉|烧烤|涮锅|自助|宴|私房|西餐|日料|韩料|铁板|海鲜)/

interface Candidate {
  name: string
  desc: string
  zone: string
  cost: number
  priceText: string
  /** 是否命中当天片区 */
  matched: boolean
  dinnerOnly: boolean
  /** 与当天片区的重合度 */
  affinity: number
  /** 与全行程片区的重合度 */
  fallback: number
  /** 这趟行程里已经吃过几次 */
  usage: number
}

/** 候选池：把城市美食清单转成候选 */
function buildCandidates(pack: CityPack, ctx: MealContext): Candidate[] {
  const usage = new Map<string, number>()
  for (const n of ctx.usedFoods) usage.set(n, (usage.get(n) ?? 0) + 1)

  const list = pack.foods.map((f) => {
    const price = parsePriceText(f.price)
    const affinity = zoneAffinity(f.zone, ctx.zones)
    const fallback = zoneAffinity(f.zone, ctx.tripZones)
    const cost = price ? Math.round((price.low + price.high) / 2) : 30
    return {
      name: f.name,
      desc: f.desc,
      zone: f.zone ?? '',
      cost,
      priceText: f.price ?? '',
      matched: affinity > 0,
      dinnerOnly: DINNER_ONLY.test(f.name),
      affinity,
      fallback,
      usage: usage.get(f.name) ?? 0,
    }
  })
  // 优先级：命中当天片区 > 吃得少 > 重合度高 > 价格低
  list.sort((a, b) => {
    if (a.matched !== b.matched) return a.matched ? -1 : 1
    if (a.usage !== b.usage) return a.usage - b.usage
    if (a.affinity !== b.affinity) return b.affinity - a.affinity
    if (a.fallback !== b.fallback) return b.fallback - a.fallback
    return a.cost - b.cost
  })
  return list
}

/**
 * 选出当天三餐
 *
 * 规则（按真实吃饭逻辑来）：
 *   - 先按价位把候选分成「便宜 / 中间 / 贵」三档，餐次对应到档位：
 *     早餐取便宜档、午餐取中间档、晚餐取贵档；
 *   - 档内排序：**吃得少的优先** → 片区命中 → 价位。
 *     「吃得少优先」是为了避免五天里四天吃火锅 —— 只按「用没用过」排序不够，
 *     因为一旦某家被用过一次，它仍然会在同价位档里赢下其余候选；
 *   - 同一家一天只出现一次，餐厅数量不够时宁可少排一顿。
 *
 * 返回按餐次建索引的结构：某餐次没有合适的店就是 undefined，
 * **不要退回成别的餐次**（把晚餐当成午餐报出来是错的）。
 */
function pickThree(candidates: Candidate[]): Record<MealSlot, Candidate | undefined> {
  const empty: Record<MealSlot, Candidate | undefined> = {
    breakfast: undefined,
    lunch: undefined,
    dinner: undefined,
  }
  if (!candidates.length) return empty

  const byCost = [...candidates].sort((a, b) => a.cost - b.cost)
  const n = byCost.length
  const third = Math.max(1, Math.ceil(n / 3))
  const cheapBand = byCost.slice(0, third)
  const expBand = byCost.slice(n - third)
  const midSlice = byCost.slice(third, n - third)
  const midBand = midSlice.length ? midSlice : byCost

  // 档内排序：吃得少 → 片区命中 → 重合度 → 价位
  const rank = (a: Candidate, b: Candidate): number => {
    if (a.usage !== b.usage) return a.usage - b.usage
    if (a.matched !== b.matched) return a.matched ? -1 : 1
    if (a.affinity !== b.affinity) return b.affinity - a.affinity
    return a.cost - b.cost
  }

  const pickFrom = (band: Candidate[], exclude: string[]): Candidate | undefined => {
    const pool = band.filter((c) => !exclude.includes(c.name))
    if (!pool.length) return undefined
    return [...pool].sort(rank)[0]
  }

  const dinner = pickFrom(expBand, [])
  // 早餐：便宜档里挑，避开「只有正餐才吃」的（火锅当早餐不合适）
  const cheapNoDinner = cheapBand.filter((c) => !c.dinnerOnly)
  const breakfast = pickFrom(
    cheapNoDinner.length ? cheapNoDinner : cheapBand,
    dinner ? [dinner.name] : []
  )
  const taken = [dinner?.name, breakfast?.name].filter(Boolean) as string[]
  const lunch = pickFrom(midBand, taken)

  return { breakfast, lunch, dinner }
}

/* ------------------------------------------------------------------ *
 * 排时间
 * ------------------------------------------------------------------ */

/** 24 小时制时间格式化 */
function fmt(h: number): string {
  const total = Math.round(h * 60)
  const hh = Math.floor(total / 60) % 24
  const mm = total % 60
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

/**
 * 在当天空档里找一个能放下这顿饭的时间
 *
 * 先在偏好窗口内找最早的空档；找不到就退到可接受范围里，
 * **取离偏好窗口最近的那个** —— 直接从最早时刻往后找，
 * 会把晚餐排到 16:00 这种不自然的钟点。
 */
function placeMeal(
  busy: Interval[],
  preferFrom: number,
  preferTo: number,
  duration: number,
  earliest: number,
  latest: number
): { start: number; end: number } | null {
  const free = (s: number): boolean =>
    busy.every((b) => s + duration <= b.start + 1e-6 || s >= b.end - 1e-6)

  // 1) 偏好窗口内最早的空档
  for (let t = preferFrom; t + duration <= preferTo; t += 0.25) {
    if (free(t)) return { start: t, end: t + duration }
  }
  // 2) 窗口外的空档：取离偏好窗口最近的那个
  let best: { start: number; end: number } | null = null
  let bestGap = Infinity
  for (let t = earliest; t + duration <= latest; t += 0.25) {
    if (!free(t)) continue
    const gap = t < preferFrom ? preferFrom - (t + duration) : t - preferTo
    if (gap < bestGap) {
      bestGap = gap
      best = { start: t, end: t + duration }
    }
  }
  return best
}

/* ------------------------------------------------------------------ *
 * 对外入口
 * ------------------------------------------------------------------ */

/**
 * 一天的餐点安排结果
 */
export interface MealPlan {
  /** 排进日程的餐点（按时间先后排列） */
  meals: MealItem[]
  /**
   * 三个餐次各自的人均价
   *
   * 排不进日程的餐次也在里面 —— 那顿饭你照样得吃。
   * 只按「排出来的」算钱，预算会凭空少几百块，超支告警也跟着失真
   * （实测：八分之一的行程日只排得出 1-2 餐）。
   */
  slotCosts: Record<MealSlot, number>
}

/** 空结果 */
function emptyPlan(): MealPlan {
  return {
    meals: [],
    slotCosts: { breakfast: 0, lunch: 0, dinner: 0 },
  }
}

/**
 * 给某一天安排三餐
 *
 * @returns 当天的餐点与三个餐次的人均价。没有可用餐厅数据时返回空结果。
 */
export function buildMeals(pack: CityPack, ctx: MealContext): MealPlan {
  if (!pack.foods.length) return emptyPlan()

  const candidates = buildCandidates(pack, ctx)
  const three = pickThree(candidates)
  if (!three.breakfast && !three.lunch && !three.dinner) return emptyPlan()

  // busy 会就地追加已排好的餐点，避免午饭和晚饭撞在同一小时
  const busy: Interval[] = ctx.busy.map((b) => ({ ...b }))
  const slotPlan: {
    slot: MealSlot
    duration: number
    prefer: [number, number]
    range: [number, number]
  }[] = [
    { slot: 'breakfast', duration: 0.75, prefer: [7.5, 9.0], range: [6.5, 11.0] },
    { slot: 'lunch', duration: 1.0, prefer: [11.5, 13.0], range: [10.5, 16.5] },
    { slot: 'dinner', duration: 1.25, prefer: [17.5, 19.0], range: [16.0, 22.0] },
  ]

  const meals: MealItem[] = []
  const taken = new Set<string>()
  for (const plan of slotPlan) {
    const cand = three[plan.slot]
    if (!cand) continue
    // 同一家不能在一顿饭里出现两次（餐厅数量不够时就少排一顿，别硬凑）
    if (taken.has(cand.name)) continue
    const slot = placeMeal(
      busy,
      plan.prefer[0],
      plan.prefer[1],
      plan.duration,
      plan.range[0],
      plan.range[1]
    )
    if (!slot) continue
    busy.push({ start: slot.start, end: slot.end })
    taken.add(cand.name)
    meals.push({
      slot: plan.slot,
      label: MEAL_LABELS[plan.slot],
      name: cand.name,
      desc: cand.desc,
      zone: cand.zone,
      cost: cand.cost,
      priceText: cand.priceText,
      startTime: fmt(slot.start),
      endTime: fmt(slot.end),
    })
  }

  return {
    meals: meals.sort((a, b) => a.startTime.localeCompare(b.startTime)),
    slotCosts: {
      breakfast: three.breakfast?.cost ?? 0,
      lunch: three.lunch?.cost ?? 0,
      dinner: three.dinner?.cost ?? 0,
    },
  }
}

/**
 * 一天的餐饮总花费（实测口径）
 *
 * @param meals 当天餐点
 * @param travelers 人数
 */
export function mealsCost(meals: MealItem[], travelers: number): number {
  return meals.reduce((s, m) => s + m.cost, 0) * Math.max(1, travelers)
}
