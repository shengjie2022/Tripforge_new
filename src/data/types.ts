/**
 * 旅游攻略定制站 —— 核心数据模型
 *
 * 坐标约定（每个城市内部使用本地公里网格）：
 *   原点 (0,0) = 城市核心商圈中心
 *   x 轴 = 正东方向距离(km)，y 轴 = 正北方向距离(km)
 *   该网格用于估算市内通勤时间，不做真实地理投影
 */

/** 兴趣标签，用于匹配用户偏好 */
export type Tag =
  | 'nature' // 自然风光
  | 'history' // 历史人文
  | 'food' // 美食
  | 'shopping' // 购物
  | 'family' // 亲子
  | 'night' // 夜生活 / 夜景
  | 'local' // 小众本地
  | 'art' // 艺术展览
  | 'relax' // 休闲慢节奏
  | 'photo' // 出片打卡
  | 'water' // 水景
  | 'mountain' // 登山户外
  | 'indoor' // 室内场馆 / 博物馆，雨天与酷暑的备选

export const TAG_LABELS: Record<Tag, string> = {
  nature: '自然风光',
  history: '历史人文',
  food: '美食',
  shopping: '购物',
  family: '亲子',
  night: '夜生活',
  local: '小众',
  art: '艺术展览',
  relax: '休闲',
  photo: '出片',
  water: '水景',
  mountain: '登山',
  indoor: '室内场馆',
}

export const ALL_TAGS: Tag[] = Object.keys(TAG_LABELS) as Tag[]

/** 预算风格 */
export type BudgetStyle = 'thrifty' | 'balanced' | 'premium'

export const BUDGET_STYLE_LABELS: Record<BudgetStyle, string> = {
  thrifty: '穷游省钱',
  balanced: '舒适均衡',
  premium: '品质精选',
}

/** 行程节奏 */
export type Pace = 'packed' | 'balanced' | 'relaxed'

export const PACE_LABELS: Record<Pace, string> = {
  packed: '紧凑暴走',
  balanced: '张弛有度',
  relaxed: '悠闲慢游',
}

/** 住宿档次 */
export type HotelTier = 'budget' | 'comfort' | 'premium'

export const HOTEL_TIER_LABELS: Record<HotelTier, string> = {
  budget: '经济型',
  comfort: '舒适型',
  premium: '高端型',
}

/** 市内交通方式 */
export type TransitMode = 'walk' | 'metro' | 'bus' | 'taxi' | 'bike' | 'car'

export const TRANSIT_LABELS: Record<TransitMode, string> = {
  walk: '步行',
  metro: '地铁 / 轨道交通',
  bus: '公交',
  taxi: '打车 / 网约车',
  bike: '共享单车',
  car: '租车自驾',
}

/** 景点适合的时段 */
export type TimeSlot = 'morning' | 'afternoon' | 'evening' | 'any'

export const TIME_SLOT_LABELS: Record<TimeSlot, string> = {
  morning: '上午',
  afternoon: '下午',
  evening: '晚间',
  any: '全天',
}

/** 城市级元数据 */
export interface City {
  id: string
  name: string
  enName: string
  country: string
  countryCode: string
  /** 搜索别名：中文简称、拼音、英文 */
  aliases: string[]
  tagline: string
  intro: string
  highlights: string[]
  /** 最佳出行月份 (1-12) */
  bestMonths: number[]
  /** 体感气候描述 */
  climate: string
  currency: string
  language: string
  timezone: string
  /** 电压/插座提示 */
  power: string
  /** 签证 / 入境提示 */
  visa: string
  /** 当地交通概况 */
  transitNote: string
  /** 城市标签 */
  tags: Tag[]
  /** 是否境外（影响大交通与签证提示） */
  overseas: boolean
  /** 真实经纬度，顺序固定为 [纬度, 经度]（lat, lng），与 haversine 的入参一致 */
  coordinates?: [number, number]
}

/** 景点 */
export interface Attraction {
  id: string
  name: string
  enName?: string
  tags: Tag[]
  /** 所属片区 */
  zone: string
  x: number
  y: number
  /** 建议游玩时长（小时） */
  hours: number
  /** 门票价格（元），0 表示免费 */
  ticket: number
  openTime: string
  bestTime: TimeSlot
  /** 口碑评分 1-5 */
  rating: number
  desc: string
  tip?: string
  /** 室内场所（雨天推荐） */
  indoor?: boolean
  /** 是否需要提前预约 */
  needBooking?: boolean
  /** 是否为标志性必去点（保证每个城市的路线里至少包含几个） */
  signature?: boolean
}

/** 住宿 */
export interface Hotel {
  id: string
  name: string
  /** 英文名（境外酒店与检索场景有用） */
  enName?: string
  /** 所属片区 */
  zone: string
  tier: HotelTier
  /** 每晚均价（元，单间） */
  price: number
  rating: number
  tags: string[]
  x: number
  y: number
  desc: string
  /** 周边地标 */
  near: string[]
}

/** 市内交通方案 */
export interface TransitOption {
  mode: TransitMode
  /** 单次基础费用（元） */
  baseCost: number
  /** 日均花费（元） */
  dailyCost: number
  /** 平均速度 km/h */
  speedKmh: number
  note: string
}

/** 一座城市的完整数据包 */
export interface CityPack {
  city: City
  attractions: Attraction[]
  hotels: Hotel[]
  transit: TransitOption[]
  /** 必吃美食 */
  foods: { name: string; desc: string; zone?: string; price?: string }[]
}

/** 全部城市的索引 */
export type CityRegistry = Record<string, CityPack>

/* ------------------------------------------------------------------ *
 * 目的地实景图（数据源：Wikimedia Commons）
 * ------------------------------------------------------------------ */

/**
 * 一张实景图
 *
 * Wikimedia 的图片几乎都是 CC-BY / CC-BY-SA / 公有领域，
 * **必须署名**，所以 author / license 字段是必填的，不要省略。
 */
export interface PhotoItem {
  /** 缩略图 URL（宽约 900px，直接可用于 <img src>） */
  url: string
  /** Commons 原始文件页（点开看大图和授权全文） */
  pageUrl: string
  /** 图片标题（已去掉 "File:" 前缀） */
  title: string
  /** 作者署名（已去掉 HTML 标签） */
  author: string
  /** 许可协议短名，如 CC BY-SA 4.0 / Public domain */
  license: string
  /** 命中这张图的查询词，用于说明「这张图对应什么」 */
  term: string
}

/* ------------------------------------------------------------------ *
 * 逐日天气
 * ------------------------------------------------------------------ */

/**
 * 某一天的天气
 *
 * 放在共享类型里，是因为引擎（DayPlan）、天气接口、界面三处都要用。
 */
export interface DailyWeather {
  /** YYYY-MM-DD（行程里的那一天） */
  date: string
  /** 最高气温 ℃ */
  high: number
  /** 最低气温 ℃ */
  low: number
  /** 当日降水量 mm */
  precip: number
  /** 降水概率 %；常年值没有这个概念，为 null */
  prob: number | null
  /** 当日是否有降水 */
  rainy: boolean
  /** 天气图标 */
  icon: string
  /** 一句话描述，如「可能有雨」 */
  label: string
  /**
   * 这个数字的来源：
   *   - `预报`：出发日期在未来 16 天内，取的是 Open-Meteo 的精确预报
   *   - `常年值`：往年同期的实测均值（ERA5 再分析数据）
   *
   * 两者混用时**逐日标注**，不让用户以为整趟都是同一种口径。
   */
  source: '预报' | '常年值'
}

/* ------------------------------------------------------------------ *
 * 大交通票价估算
 * ------------------------------------------------------------------ */

/** 大交通方式 */
export type LongDistanceMode = 'train' | 'highspeed' | 'flight'

/**
 * 一个席别/舱位的票价估算
 *
 * 注意：这是**按里程推算的量级区间**，不是实时票价。
 * 12306 没有公开 API，且不返回 CORS 头，纯前端拿不到实时票价，
 * 所以这里给区间 + 官方查询直达链接，由用户自己确认真实票价。
 */
export interface FareQuote {
  mode: LongDistanceMode
  /** 中文名，如「高铁」 */
  label: string
  /** 席别 / 舱位，如「二等座」 */
  seat: string
  /** 单人票价下限（元） */
  low: number
  /** 单人票价上限（元） */
  high: number
  /** 官方实时查询入口名，如「去 12306 查」 */
  queryName: string
  /** 官方实时查询直达链接 */
  queryUrl: string
  /** 补充说明（如「需中转」） */
  note: string
}
