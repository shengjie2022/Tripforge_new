/**
 * 大交通票价估算 —— 按里程推算的**量级区间**，不是实时票价。
 *
 * 为什么只能是估算区间：
 *   1. 12306 没有公开 API；
 *   2. kyfw.12306.cn 不返回 access-control-allow-origin 头，浏览器直连会被 CORS 拦掉；
 *   3. 12306 的查询端点名几周一轮换（queryO / queryZ / queryA / queryG…），硬编码很快失效；
 *   4. 本站部署在 GitHub Pages，是纯静态站，没有后端可以代理这些请求。
 *
 * 所以本模块做两件事：
 *   - 按出发地→目的地的直线距离，给出各席别 / 舱位的**票价量级区间**（用于做预算分配）；
 *   - 同时给出**官方票务查询直达链接**，由用户自己确认真实票价与车次。
 *
 * 估算口径（参照境内铁路 / 航空常见的单公里票价量级）：
 *   火车硬座    max(8,  km × 0.050) ~ max(12,  km × 0.075)
 *   火车硬卧    硬座区间 × 1.70 ~ × 1.95
 *   高铁二等座  max(55, km × 0.380) ~ max(70,  km × 0.480)
 *   飞机经济舱  max(180, km × 0.550) ~ max(260, km × 0.950)
 * 所有金额四舍五入到 5 元。
 *
 * 时长口径（只用于文案，不参与票价计算）：
 *   高铁约 km / 250 小时，飞机约 km / 800 小时 + 1.5 小时起降，
 *   普速火车约 km / 100 小时（含停站）。
 */

import type { FareQuote, LongDistanceMode } from '../data/types'
import { todayISO } from '../utils/date'

/** 季节档位 */
type Season = 'peak' | 'off' | 'normal'

/** 旺季（暑运）月份 */
const PEAK_MONTHS = [6, 7, 8]
/** 淡季月份 */
const OFF_MONTHS = [11, 12, 1, 2]

/** 各方式的官方查询入口名 */
const QUERY_NAME: Record<LongDistanceMode, string> = {
  flight: '去同程查实时价',
  highspeed: '去携程查实时价',
  train: '去 12306 查实时价',
}

/** 内部用的候选条目（还没填 note / queryUrl） */
type Candidate = {
  mode: LongDistanceMode
  label: string
  seat: string
  low: number
  high: number
}

/** 四舍五入到 5 元 */
function round5(x: number): number {
  return Math.round(x / 5) * 5
}

/** 判断出行月份属于哪个季节档位 */
function seasonOf(month: number | undefined): Season {
  if (month === undefined || !Number.isFinite(month)) return 'normal'
  const m = Math.round(month)
  if (m < 1 || m > 12) return 'normal'
  if (PEAK_MONTHS.includes(m)) return 'peak'
  if (OFF_MONTHS.includes(m)) return 'off'
  return 'normal'
}

/** 把小时数写成「X 小时」/「X 分钟」 */
function formatDuration(hours: number): string {
  if (hours < 1) {
    const minutes = Math.max(10, Math.round((hours * 60) / 5) * 5)
    return `${minutes} 分钟`
  }
  const h = Math.round(hours * 2) / 2
  return h % 1 === 0 ? `${h} 小时` : `${h.toFixed(1)} 小时`
}

/**
 * 携程火车购票直达链接（带出发地 / 目的地 / 出行日期）。
 * dateISO 形如 2026-11-05。
 */
export function trainQueryUrl(fromCity: string, toCity: string, dateISO: string): string {
  return `https://trains.ctrip.com/TrainBooking/Search.aspx?from=${encodeURIComponent(
    fromCity
  )}&to=${encodeURIComponent(toCity)}&day=${dateISO}`
}

/**
 * 同程机票查询入口。
 *
 * 同程首页稳定可访问；携程机票页有反爬（会返回 432），不可靠，所以统一导向同程。
 * 同程没有稳定的可直传检索参数，故 from / to / date 暂不拼进 URL，
 * 保留在签名里是为了与另外两个查询函数保持一致的调用形态。
 */
export function flightQueryUrl(fromCity: string, toCity: string, dateISO: string): string {
  void fromCity
  void toCity
  void dateISO
  return 'https://www.ly.com/'
}

/**
 * 门票价格查询入口
 *
 * 原来指向去哪儿 `piao.qunar.com/ticket/list.htm?keyword=…`，
 * **实测那个地址已经打不开了** —— headless 与有头 Chrome 都是 200 + 0 字节白页，
 * 用户的点进进去只看到一片空白。同一批实测里：
 *   - 携程火车深链 ✅ 正常（连车次都出得来）
 *   - 同程首页 ✅ 正常
 *   - 去哪儿新版搜索路径 ❌ 404
 *   - 美团 / 携程全站搜索 / 马蜂窝 ❌ 404 或空页
 *
 * 按景点名能稳定打开的只有搜索入口，所以改成搜索「<景点>门票」——
 * 结果页里就是各票务平台的实时票价页，比一个打不开的「直达」诚实。
 */
export function ticketQueryUrl(attractionName: string): string {
  return `https://www.baidu.com/s?wd=${encodeURIComponent(attractionName + '门票')}`
}

/**
 * 12306 官方购票入口。
 *
 * 12306 首页需要用户自己选站、选日期，没有稳定的深链参数格式，
 * 所以 from / to / date 不参与 URL 拼接。
 */
export function officialFareLink(fromCity: string, toCity: string, dateISO: string): string {
  void fromCity
  void toCity
  void dateISO
  return 'https://www.12306.cn/index/'
}

/**
 * 估算「出发地 → 目的地」的大交通票价区间。
 *
 * @param fromCity 出发城市名（用于生成查询链接）
 * @param toCity   目的地城市名（用于生成查询链接）
 * @param km       两地直线距离（km）
 * @param overseas 是否境外目的地；为 true 时只给国际航班
 * @param month    出行月份 1-12；影响机票的旺季 / 淡季系数
 * @param dateISO  查询链接上的出行日期（YYYY-MM-DD）；缺省用当天
 */
export function estimateFares(input: {
  fromCity: string
  toCity: string
  km: number
  overseas?: boolean
  month?: number
  dateISO?: string
}): FareQuote[] {
  const km = Math.max(0, Number.isFinite(input.km) ? input.km : 0)
  const season = seasonOf(input.month)
  const dateISO = input.dateISO || todayISO()
  /** 超过 1500km 一般无法一次直达 */
  const needsTransfer = km > 1500

  // —— 基准票价（尚未做季节调整）——
  const seatLow = Math.max(8, km * 0.05)
  const seatHigh = Math.max(12, km * 0.075)
  const sleeperLow = seatLow * 1.7
  const sleeperHigh = seatHigh * 1.95
  const hsrLow = Math.max(55, km * 0.38)
  const hsrHigh = Math.max(70, km * 0.48)
  let airLow = Math.max(180, km * 0.55)
  let airHigh = Math.max(260, km * 0.95)

  // —— 季节调整只作用在机票上 ——
  if (season === 'peak') {
    airHigh = airHigh * 1.25
  } else if (season === 'off') {
    airLow = airLow * 0.85
    airHigh = airHigh * 0.85
  }

  const hsr: Candidate = {
    mode: 'highspeed',
    label: '高铁',
    seat: '二等座',
    low: hsrLow,
    high: hsrHigh,
  }
  const air: Candidate = {
    mode: 'flight',
    label: '飞机',
    seat: '经济舱',
    low: airLow,
    high: airHigh,
  }
  const hardSeat: Candidate = {
    mode: 'train',
    label: '火车',
    seat: '硬座',
    low: seatLow,
    high: seatHigh,
  }
  const hardSleeper: Candidate = {
    mode: 'train',
    label: '火车',
    seat: '硬卧',
    low: sleeperLow,
    high: sleeperHigh,
  }

  const candidates: Candidate[] = []
  if (input.overseas === true) {
    // 境外目的地：只有国际航班
    candidates.push(air)
  } else if (km < 300) {
    candidates.push(hardSeat, hardSleeper, hsr)
  } else if (km < 800) {
    candidates.push(hsr, air, hardSleeper)
  } else if (km < 1500) {
    candidates.push(hsr, air)
  } else {
    candidates.push(air, hsr)
  }

  // 排序：远距离优先推荐飞机，近距离优先推荐高铁
  const rank = (mode: LongDistanceMode): number => {
    if (km >= 800) return mode === 'flight' ? 0 : mode === 'highspeed' ? 1 : 2
    return mode === 'highspeed' ? 0 : mode === 'flight' ? 1 : 2
  }
  candidates.sort((a, b) => rank(a.mode) - rank(b.mode))

  const buildNote = (mode: LongDistanceMode): string => {
    if (input.overseas === true) return '境外目的地，需国际航班与签证'
    const hours =
      mode === 'flight'
        ? km / 800 + 1.5
        : mode === 'highspeed'
          ? km / 250
          : km / 100
    const parts: string[] = [
      needsTransfer
        ? `约 ${formatDuration(hours)}`
        : `约 ${formatDuration(hours)} 直达`,
    ]
    if (needsTransfer) parts.push('需中转')
    if (mode === 'flight') {
      if (season === 'peak') parts.push('旺季价格上浮')
      else if (season === 'off') parts.push('淡季价格更低')
    }
    return parts.join(' · ')
  }

  const buildQueryUrl = (mode: LongDistanceMode): string => {
    if (mode === 'flight') return flightQueryUrl(input.fromCity, input.toCity, dateISO)
    if (mode === 'highspeed') return trainQueryUrl(input.fromCity, input.toCity, dateISO)
    return officialFareLink(input.fromCity, input.toCity, dateISO)
  }

  return candidates.map((c) => {
    const low = Math.max(1, round5(c.low))
    const high = Math.max(low, round5(c.high))
    return {
      mode: c.mode,
      label: c.label,
      seat: c.seat,
      low,
      high,
      queryName: QUERY_NAME[c.mode],
      queryUrl: buildQueryUrl(c.mode),
      note: buildNote(c.mode),
    }
  })
}
