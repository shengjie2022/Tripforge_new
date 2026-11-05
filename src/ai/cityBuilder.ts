/**
 * 用大模型生成「城市素材包」
 *
 * 分工非常明确：
 *   - 大模型只负责**素材**：这个城市有哪些景点、门票多少、住哪、吃什么、怎么走
 *   - 本地规则引擎负责**编排**：聚类、分天、时间轴、预算、住宿选择
 *
 * 这样做的原因：本地引擎的硬约束（同日 15km、22:30 收工、每日夜间点 ≤1、
 * 预算偏差 <6%）全部保留，模型输出再乱也不会产出离谱行程；
 * 而且同一个城市多次生成的结果稳定，可复现。
 *
 * 关键技巧：**不让模型给经纬度**。模型给坐标很不准，改为让它给
 * 「相对核心商圈的方位 + 距离」，再由代码转换成内部使用的公里网格坐标。
 *
 * 抗截断设计（实测踩坑）：
 *   - 提示必须要求「紧凑 JSON」，否则模型默认缩进 + 长描述，token 很快烧光
 *   - 拆成两次调用（城市+景点 / 酒店+交通+美食），单次输出量减半
 *   - 识别 max_tokens 截断后，自动重试一次并尝试关闭模型思考模式
 */

import { chatJSON, TruncatedOutputError } from './json'
import type { AIConfig } from './client'
import {
  ALL_TAGS,
  type Attraction,
  type BudgetStyle,
  type City,
  type CityPack,
  type Hotel,
  type HotelTier,
  type Pace,
  type Tag,
  type TimeSlot,
  type TransitMode,
  type TransitOption,
} from '../data/types'

/** 方位词 → 以正北为 0°、顺时针的角度 */
const BEARING_ANGLE: Record<string, number> = {
  北: 0,
  东北: 45,
  东: 90,
  东南: 135,
  南: 180,
  西南: 225,
  西: 270,
  西北: 315,
  中心: 0,
}

const BEARING_KEYS = Object.keys(BEARING_ANGLE)

const TIME_SLOTS: TimeSlot[] = ['morning', 'afternoon', 'evening', 'any']
const TRANSIT_MODES: TransitMode[] = ['walk', 'metro', 'bus', 'taxi', 'bike', 'car']
const HOTEL_TIERS: HotelTier[] = ['budget', 'comfort', 'premium']

/** 常用中国城市真实坐标兜底（模型给的坐标不可信时的保险），顺序为 [纬度, 经度] */
const FALLBACK_COORDS: Record<string, [number, number]> = {
  北京: [39.9, 116.41], 上海: [31.23, 121.47], 广州: [23.13, 113.26],
  深圳: [22.54, 114.06], 杭州: [30.27, 120.15], 南京: [32.06, 118.8],
  苏州: [31.3, 120.58], 成都: [30.57, 104.07], 重庆: [29.56, 106.55],
  武汉: [30.59, 114.31], 西安: [34.34, 108.94], 天津: [39.13, 117.2],
  沈阳: [41.8, 123.43], 哈尔滨: [45.8, 126.53], 长春: [43.88, 125.32],
  大连: [38.91, 121.61], 济南: [36.65, 117.12], 青岛: [36.07, 120.38],
  郑州: [34.75, 113.63], 长沙: [28.23, 112.94], 南昌: [28.68, 115.86],
  合肥: [31.82, 117.23], 福州: [26.07, 119.3], 厦门: [24.48, 118.09],
  昆明: [25.04, 102.71], 贵阳: [26.65, 106.63], 南宁: [22.82, 108.32],
  海口: [20.04, 110.2], 三亚: [18.25, 109.51], 兰州: [36.06, 103.83],
  西宁: [36.62, 101.78], 银川: [38.49, 106.23], 乌鲁木齐: [43.83, 87.62],
  拉萨: [29.65, 91.14], 呼和浩特: [40.84, 111.75], 太原: [37.87, 112.55],
  石家庄: [38.04, 114.51], 宁波: [29.87, 121.55], 无锡: [31.49, 120.31],
  温州: [27.99, 120.7], 佛山: [23.02, 113.12], 东莞: [23.02, 113.75],
  珠海: [22.27, 113.58], 泉州: [24.87, 118.68], 汕头: [23.35, 116.68],
  徐州: [34.26, 117.19], 洛阳: [34.62, 112.45], 开封: [34.8, 114.31],
  大理: [25.61, 100.27], 丽江: [26.86, 100.23], 桂林: [25.27, 110.29],
  柳州: [24.33, 109.42], 绵阳: [31.47, 104.68], 宜宾: [28.75, 104.64],
  遵义: [27.73, 106.93], 西昌: [27.89, 102.27], 敦煌: [40.14, 94.66],
  嘉峪关: [39.77, 98.29], 张家界: [29.12, 110.48], 凤凰: [27.95, 109.6],
  黄山: [30.13, 118.17], 泰山: [36.2, 117.1], 曲阜: [35.6, 116.99],
  扬州: [32.39, 119.41], 镇江: [32.19, 119.45], 绍兴: [30.03, 120.58],
  嘉兴: [30.75, 120.76], 台州: [28.66, 121.42], 南阳: [32.99, 112.53],
  安阳: [36.1, 114.39], 天水: [34.58, 105.72], 汉中: [33.07, 107.03],
  延安: [36.6, 109.49], 大同: [40.08, 113.3], 临汾: [36.09, 111.52],
  运城: [35.03, 111.0], 丹东: [40.12, 124.38], 延吉: [42.9, 129.51],
  威海: [37.51, 122.12], 烟台: [37.46, 121.45], 潍坊: [36.71, 119.16],
  淄博: [36.81, 118.05], 临沂: [35.06, 118.36],
}

/** 已知城市直接用真实坐标，不信任模型给的 */
export function lookupCoords(cityName: string): [number, number] | undefined {
  return FALLBACK_COORDS[cityName]
}

/** 方位 + 距离 → 内部公里网格坐标（x 正东，y 正北） */
export function polarToGrid(bearing: string, distanceKm: number): { x: number; y: number } {
  const key = BEARING_KEYS.find((b) => b === bearing) ?? '中心'
  const angle = (BEARING_ANGLE[key] * Math.PI) / 180
  // 距离必须是有限数：Math.max(0, NaN) 还是 NaN，
  // 而路线图直接拿 x/y 画 SVG，一个 NaN 就能让整张图渲染成空白
  const d = Number.isFinite(distanceKm) ? Math.max(0, distanceKm) : 0
  return {
    x: Number((d * Math.sin(angle)).toFixed(2)),
    y: Number((d * Math.cos(angle)).toFixed(2)),
  }
}

/* ------------------------------------------------------------------ */
/* 模型输出 → 内部类型                                                */
/* ------------------------------------------------------------------ */

interface RawAttraction {
  name?: unknown
  zone?: unknown
  bearing?: unknown
  distance?: unknown
  tags?: unknown
  hours?: unknown
  ticket?: unknown
  openTime?: unknown
  bestTime?: unknown
  rating?: unknown
  desc?: unknown
  tip?: unknown
  indoor?: unknown
  needBooking?: unknown
  signature?: unknown
}

interface RawHotel {
  name?: unknown
  zone?: unknown
  tier?: unknown
  price?: unknown
  rating?: unknown
  tags?: unknown
  bearing?: unknown
  distance?: unknown
  desc?: unknown
  near?: unknown
}

interface RawTransit {
  mode?: unknown
  baseCost?: unknown
  dailyCost?: unknown
  speedKmh?: unknown
  note?: unknown
}

interface RawCity {
  enName?: unknown
  tagline?: unknown
  intro?: unknown
  highlights?: unknown
  bestMonths?: unknown
  climate?: unknown
  transitNote?: unknown
  visa?: unknown
  tags?: unknown
  latitude?: unknown
  longitude?: unknown
  centerName?: unknown
}

interface RawPart1 {
  city?: RawCity
  attractions?: RawAttraction[]
}

interface RawPart2 {
  hotels?: RawHotel[]
  transit?: RawTransit[]
  foods?: { name?: unknown; desc?: unknown; zone?: unknown; price?: unknown }[]
}

/* ------------------------- 清洗工具函数 ------------------------- */

function asText(v: unknown, max = 200): string {
  if (typeof v === 'string') return v.trim().slice(0, max)
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return ''
}

function asNumber(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : fallback
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

function asTags(v: unknown): Tag[] {
  const out: Tag[] = []
  for (const t of asArray(v)) {
    const s = asText(t, 20).toLowerCase()
    if ((ALL_TAGS as string[]).includes(s) && !out.includes(s as Tag)) out.push(s as Tag)
  }
  return out.slice(0, 4)
}

function asBearing(v: unknown): string {
  const s = asText(v, 6)
  if (BEARING_KEYS.includes(s)) return s
  // 容忍 "城市东南" / "东南方" 这类写法
  const hit = BEARING_KEYS.find((b) => b !== '中心' && s.includes(b))
  return hit ?? '中心'
}

function asBestTime(v: unknown): TimeSlot {
  const s = asText(v, 12).toLowerCase()
  if (TIME_SLOTS.includes(s as TimeSlot)) return s as TimeSlot
  const map: Record<string, TimeSlot> = {
    上午: 'morning', 早晨: 'morning', 早上: 'morning',
    下午: 'afternoon', 傍晚: 'afternoon', 午后: 'afternoon',
    晚上: 'evening', 夜: 'evening', 夜间: 'evening',
    全天: 'any', 任意: 'any', 不限: 'any',
  }
  return map[s] ?? 'any'
}

function asOpenTime(v: unknown): string {
  const s = asText(v, 24)
  return /\d{1,2}\s*[:：]\s*\d{2}/.test(s) ? s : '09:00-17:30'
}

/* --------------------------- 清洗主逻辑 --------------------------- */

function cleanAttractions(raw: RawAttraction[]): Attraction[] {
  const out: Attraction[] = []
  const seen = new Set<string>()
  raw.forEach((r, i) => {
    const name = asText(r.name, 24)
    if (!name) return
    if (seen.has(name)) return
    seen.add(name)

    const bearing = asBearing(r.bearing)
    const distance = clamp(asNumber(r.distance, 3), 0, 45)
    const { x, y } = polarToGrid(bearing, distance)
    const ticket = Math.round(clamp(asNumber(r.ticket, 0), 0, 800))

    out.push({
      id: `ai-a-${i}-${name.slice(0, 8)}`,
      name,
      tags: asTags(r.tags),
      zone: asText(r.zone, 16) || '市中心',
      x,
      y,
      hours: Number(clamp(asNumber(r.hours, 2), 0.5, 8).toFixed(1)),
      ticket,
      openTime: asOpenTime(r.openTime),
      bestTime: asBestTime(r.bestTime),
      rating: Number(clamp(asNumber(r.rating, 4.2), 1, 5).toFixed(1)),
      desc: asText(r.desc, 60) || `${name}，当地值得一去的地方。`,
      tip: asText(r.tip, 40) || undefined,
      indoor: r.indoor === true,
      needBooking: r.needBooking === true,
      signature: r.signature === true,
    })
  })
  return out
}

function cleanHotels(raw: RawHotel[]): Hotel[] {
  const out: Hotel[] = []
  const seen = new Set<string>()
  raw.forEach((r, i) => {
    const name = asText(r.name, 24)
    if (!name) return
    if (seen.has(name)) return
    seen.add(name)

    const price = Math.round(clamp(asNumber(r.price, 350), 60, 6000))
    const tierRaw = asText(r.tier, 12).toLowerCase()
    const tier: HotelTier = HOTEL_TIERS.includes(tierRaw as HotelTier)
      ? (tierRaw as HotelTier)
      : price < 320
        ? 'budget'
        : price < 780
          ? 'comfort'
          : 'premium'

    const bearing = asBearing(r.bearing)
    const { x, y } = polarToGrid(bearing, clamp(asNumber(r.distance, 2), 0, 25))

    out.push({
      id: `ai-h-${i}-${name.slice(0, 8)}`,
      name,
      zone: asText(r.zone, 16) || '市中心',
      tier,
      price,
      rating: Number(clamp(asNumber(r.rating, 4.3), 1, 5).toFixed(1)),
      tags: asArray(r.tags).map((t) => asText(t, 10)).filter(Boolean).slice(0, 3),
      x,
      y,
      desc: asText(r.desc, 50) || `${name}，${price} 元/晚。`,
      near: asArray(r.near).map((n) => asText(n, 16)).filter(Boolean).slice(0, 3),
    })
  })
  return out
}

function cleanTransit(raw: RawTransit[]): TransitOption[] {
  const out: TransitOption[] = []
  const seen = new Set<TransitMode>()
  for (const r of raw) {
    const mode = asText(r.mode, 12).toLowerCase() as TransitMode
    if (!TRANSIT_MODES.includes(mode) || seen.has(mode)) continue
    seen.add(mode)
    out.push({
      mode,
      baseCost: Math.round(clamp(asNumber(r.baseCost, 2), 0, 200)),
      dailyCost: Math.round(clamp(asNumber(r.dailyCost, 15), 0, 400)),
      speedKmh: Number(clamp(asNumber(r.speedKmh, 20), 4, 130).toFixed(0)),
      note: asText(r.note, 40) || `${mode} 出行`,
    })
  }
  return out
}

function cleanFoods(raw: RawPart2['foods']): CityPack['foods'] {
  const out: CityPack['foods'] = []
  const seen = new Set<string>()
  for (const f of raw ?? []) {
    const name = asText(f?.name, 16)
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push({
      name,
      desc: asText(f?.desc, 50) || `${name}，当地代表性吃食。`,
      zone: asText(f?.zone, 12) || undefined,
      price: asText(f?.price, 12) || undefined,
    })
  }
  return out
}

function cleanCity(raw: RawCity, cityName: string, cityId: string): City {
  const months = asArray(raw?.bestMonths)
    .map((m) => Math.round(asNumber(m, 0)))
    .filter((m) => m >= 1 && m <= 12)
  const uniqueMonths = Array.from(new Set(months))

  const lat = asNumber(raw?.latitude, NaN)
  const lng = asNumber(raw?.longitude, NaN)
  const modelCoords: [number, number] | undefined =
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180 &&
    !(lat === 0 && lng === 0)
      ? [Number(lat.toFixed(3)), Number(lng.toFixed(3))]
      : undefined

  return {
    id: cityId,
    name: cityName,
    enName: asText(raw?.enName, 30) || cityName,
    country: '中国',
    countryCode: 'CN',
    aliases: [cityName],
    tagline: asText(raw?.tagline, 30) || `${cityName}，值得专程来一次`,
    intro: asText(raw?.intro, 160) || `${cityName}的行程由大模型资料 + 本地引擎编排生成。`,
    highlights: asArray(raw?.highlights).map((h) => asText(h, 30)).filter(Boolean).slice(0, 5),
    bestMonths: uniqueMonths.length ? uniqueMonths : [4, 5, 9, 10],
    climate: asText(raw?.climate, 80) || `${cityName}四季分明，春秋两季最舒适。`,
    currency: '人民币',
    language: '中文',
    timezone: 'UTC+8',
    power: '220V，两孔插座',
    visa: '境内旅游，无需签证',
    transitNote: asText(raw?.transitNote, 90) || `${cityName}以公交与网约车为主。`,
    tags: asTags(raw?.tags),
    overseas: false,
    coordinates: modelCoords ?? lookupCoords(cityName),
  }
}

/* --------------------------- 校验与补齐 --------------------------- */

export interface PackIssues {
  /** 景点数量是否够排满行程 */
  enoughAttractions: boolean
  /** 三个住宿档次是否都有 */
  tiersCovered: boolean
  attractionCount: number
  hotelCount: number
  foodCount: number
  notes: string[]
}

export function inspectPack(pack: CityPack): PackIssues {
  const notes: string[] = []
  const tiers = new Set(pack.hotels.map((h) => h.tier))
  const missingTiers = HOTEL_TIERS.filter((t) => !tiers.has(t))

  if (pack.attractions.length < 10) {
    notes.push(`景点偏少（${pack.attractions.length} 个），长行程可能出现空天`)
  }
  if (missingTiers.length) {
    notes.push(`缺少${missingTiers.join('/')}档住宿，已按价格自动归档`)
  }
  if (pack.foods.length < 5) notes.push('美食清单偏少')

  return {
    enoughAttractions: pack.attractions.length >= 10,
    tiersCovered: missingTiers.length === 0,
    attractionCount: pack.attractions.length,
    hotelCount: pack.hotels.length,
    foodCount: pack.foods.length,
    notes,
  }
}

/** 交通方式兜底：模型没给够就用通用配置补齐 */
function fillTransit(list: TransitOption[]): TransitOption[] {
  const defaults: TransitOption[] = [
    { mode: 'walk', baseCost: 0, dailyCost: 0, speedKmh: 4.5, note: '短距离步行最省事' },
    { mode: 'metro', baseCost: 3, dailyCost: 15, speedKmh: 35, note: '轨道交通覆盖主要区域' },
    { mode: 'bus', baseCost: 2, dailyCost: 10, speedKmh: 18, note: '公交覆盖广、票价低' },
    { mode: 'taxi', baseCost: 12, dailyCost: 60, speedKmh: 28, note: '打车 / 网约车灵活但费用高' },
  ]
  const out = [...list]
  for (const d of defaults) {
    if (!out.some((t) => t.mode === d.mode)) out.push(d)
  }
  return out
}

/* ----------------------------- 提示词 ----------------------------- */

/** 公共规则（坐标约定 + 省 token 要求 + 输出格式） */
const COMMON_RULES = `你是旅行数据工程师，为中文旅游网站生成城市资料 JSON。

坐标：不要经纬度。给 bearing（东/东南/南/西南/西/西北/北/东北/中心）+ distance（距市中心公里数，小数，0.5-40）。

省 token 的硬要求：
- 输出紧凑 JSON，不要缩进、不要换行、不要注释
- desc 不超过 25 字，tip 不超过 20 字，name 不超过 12 字
- tags 最多 3 个，只能是：${ALL_TAGS.join(',')}
- hours 整数或一位小数；ticket 整数；rating 一位小数
- openTime 写 "08:00-17:30" 这种格式
- bestTime 用 morning/afternoon/evening/any

只输出一个 JSON 对象，不要任何解释文字、不要 markdown 围栏。`

const PART1_SYSTEM = `${COMMON_RULES}

本次只输出 city 与 attractions 两项：
{"city":{"enName":"","tagline":"","intro":"","highlights":["","","",""],"bestMonths":[4,5],"climate":"","transitNote":"","tags":["history"],"latitude":0,"longitude":0},"attractions":[{"name":"","zone":"","bearing":"东南","distance":12.5,"tags":["history"],"hours":3,"ticket":90,"openTime":"08:00-17:30","bestTime":"morning","rating":4.7,"desc":"","tip":"","indoor":false,"needBooking":true,"signature":true}]}

attractions 给 15 个，覆盖历史人文、自然风光、美食街区、网红打卡、地标建筑多种类型；至少 3 个 signature=true（当地非去不可的地标）；门票与开放时间必须真实合理，免费写 ticket=0；室内场馆 indoor=true。
只收录「景点」：博物馆、古迹、公园、街区、山水、展馆等可参观的地方。餐馆、饭店、小吃店不要放进 attractions（它们属于 foods）。`

const PART2_SYSTEM = `${COMMON_RULES}

本次只输出 hotels、transit、foods 三项：
{"hotels":[{"name":"","zone":"","tier":"comfort","price":420,"rating":4.5,"tags":["近地铁"],"bearing":"东","distance":2.5,"desc":"","near":["",""]}],"transit":[{"mode":"metro","baseCost":3,"dailyCost":15,"speedKmh":35,"note":""}],"foods":[{"name":"","desc":"","zone":"","price":""}]}

hotels 给 9 个，必须覆盖三个价位：经济型 tier=budget（100-300 元/晚）、舒适型 tier=comfort（350-800 元/晚）、高端型 tier=premium（1000 元/晚以上），每档至少 2 个。
transit 给 4-6 种，mode 只能用 walk/metro/bus/taxi/bike/car。
foods 给 10 种当地必吃，price 写 "20-40元" 这种格式。`

const SUPPLEMENT_SYSTEM = `${COMMON_RULES}

只输出 attractions：
{"attractions":[{"name":"","zone":"","bearing":"东南","distance":12.5,"tags":["history"],"hours":3,"ticket":90,"openTime":"08:00-17:30","bestTime":"morning","rating":4.7,"desc":"","tip":"","indoor":false,"needBooking":true,"signature":false}]}

请补充 10 个前面没提过的景点，不要重复常见的那几个。`

export interface BuildCityOptions {
  cityName: string
  days: number
  month: number
  budget: number
  travelers: number
  style: BudgetStyle
  pace: Pace
  prefs: Tag[]
}

export interface BuildCityResult {
  pack: CityPack
  issues: PackIssues
  /** 实际用了几次模型调用 */
  attempts: number
}

function contextLine(opts: BuildCityOptions): string {
  return `城市：${opts.cityName}
行程天数：${opts.days} 天
出行月份：${opts.month} 月
总预算：${opts.budget} 元
人数：${opts.travelers} 人
消费风格：${opts.style}
节奏：${opts.pace}
兴趣偏好：${opts.prefs.join('、') || '均衡'}`
}

/**
 * 调用模型，截断时自动换策略重试一次（关思考模式）。
 * 关思考模式部分模型不支持会 400，此时退回原始错误。
 */
async function callWithRetry<T>(
  cfg: AIConfig,
  system: string,
  user: string,
  signal?: AbortSignal
): Promise<T> {
  try {
    return await chatJSON<T>(cfg, system, user, { temperature: 0.4, signal })
  } catch (e) {
    if (e instanceof TruncatedOutputError) {
      // 第一次被截断：关掉思考模式再试一次（不支持的模型会直接 400，那就算了）
      return chatJSON<T>(cfg, system, user, {
        temperature: 0.4,
        signal,
        disableThinking: true,
      })
    }
    throw e
  }
}

/** 生成城市素材包 */
export async function buildCityPack(
  cfg: AIConfig,
  opts: BuildCityOptions,
  signal?: AbortSignal
): Promise<BuildCityResult> {
  const cityId = `ai:${opts.cityName}`
  let attempts = 0

  // ---- 第一部分：城市信息 + 景点 ----
  const part1 = await callWithRetry<RawPart1>(
    cfg,
    PART1_SYSTEM,
    `${contextLine(opts)}\n\n生成「${opts.cityName}」的 city 与 attractions。`,
    signal
  )
  attempts++

  let attractions = cleanAttractions(part1?.attractions ?? [])

  // 景点不够就补一轮
  if (attractions.length < 10) {
    const extra = await callWithRetry<{ attractions?: RawAttraction[] }>(
      cfg,
      SUPPLEMENT_SYSTEM,
      `${contextLine(opts)}\n\n这是「${opts.cityName}」的补充景点。已有：${attractions
        .map((a) => a.name)
        .join('、')}。请给出另外 10 个不重复的景点。`,
      signal
    )
    attempts++
    attractions = cleanAttractions([...(part1?.attractions ?? []), ...(extra?.attractions ?? [])])
  }

  // ---- 第二部分：酒店 + 交通 + 美食 ----
  const part2 = await callWithRetry<RawPart2>(
    cfg,
    PART2_SYSTEM,
    `${contextLine(opts)}\n\n生成「${opts.cityName}」的 hotels、transit、foods。`,
    signal
  )
  attempts++

  const hotels = cleanHotels(part2?.hotels ?? [])
  const transit = fillTransit(cleanTransit(part2?.transit ?? []))
  const foods = cleanFoods(part2?.foods ?? [])
  const city = cleanCity(part1?.city ?? {}, opts.cityName, cityId)

  const pack: CityPack = { city, attractions, hotels, transit, foods }
  return { pack, issues: inspectPack(pack), attempts }
}
