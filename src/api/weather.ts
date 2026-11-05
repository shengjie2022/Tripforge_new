/**
 * 目的地天气 —— Open-Meteo（免费、无需 API Key、允许跨域直连）
 *
 * 为什么用 Open-Meteo：
 *   - 免注册免 Key，不给外部服务添麻烦；
 *   - 带 Origin 请求时返回 `access-control-allow-origin: *`（已实测），浏览器可直连；
 *   - 同时提供「未来 16 天预报」和「历史气候实测」，能满足「还没定具体日期」的咨询场景。
 *
 * 两种数据源：
 *   - 出发日期在未来 16 天内 → 用 forecast 接口，拿精确预报（含降水概率）；
 *   - 否则 → 用 archive 接口取最近几年同月的实测值，算「常年值」。
 *     常年值比凭空编的「季节性建议」靠谱得多，而且不需要用户先定日期。
 *
 * **逐日口径**：所有统计都基于「行程实际占用的那几天」，
 * 而不是整个预报窗口。这样「未来 16 天里有 3 天下雨」这种数字不会出现在
 * 用户的三天行程卡片上 —— 用户关心的是「我这三天天气怎么样」。
 *
 * 局限：archive 的 ERA5 数据有几天滞后，最近的年份可能缺几天 —— 所以取 3 年样本。
 *
 * 失败一律返回 null（界面不显示天气卡片），绝不影响攻略主流程。
 */

import type { DailyWeather } from '../data/types'
import { addDays, daysBetween, toISO, todayISO } from '../utils/date'

const FORECAST_ENDPOINT = 'https://api.open-meteo.com/v1/forecast'
const ARCHIVE_ENDPOINT = 'https://archive-api.open-meteo.com/v1/archive'

/** 缓存 key 前缀 */
const CACHE_PREFIX = 'tripforge.weather.v2.'

/** 常年值缓存有效期：30 天（气候常年值变化很慢） */
const CLIMATE_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * 预报缓存有效期：6 小时
 *
 * 预报只覆盖「当天 + 15 天」，放 30 天就意味着可能拿一份 20 天前的旧预报
 * 冒充最新预报，而且缓存窗口滑过去之后会静默退化成常年值。
 */
const FORECAST_TTL_MS = 6 * 60 * 60 * 1000

/** 预报接口最多覆盖未来 16 天 */
const FORECAST_DAYS = 16

/** 取多少年的历史样本 */
const HISTORY_YEARS = 3

/**
 * ERA5 再分析数据的滞后天数
 *
 * 既是数据本身的滞后，也用来避开 archive 接口的一个坑：
 * **end_date 不能是未来日期**，否则整个请求直接 400（实测 2026-12-31 → 400，
 * 2026-10-20 → 200）。留 10 天余量。
 */
const ERA5_LAG_DAYS = 10

/** 单次请求超时 */
const REQUEST_TIMEOUT_MS = 9000

/** 判定「有降水」的日降水量门槛（mm） */
const RAIN_THRESHOLD_MM = 0.5

/* ------------------------------------------------------------------ *
 * 类型
 * ------------------------------------------------------------------ */

/** 整趟行程的天气概览 */
export interface WeatherInfo {
  /** 平均最高气温 ℃ */
  high: number
  /** 平均最低气温 ℃ */
  low: number
  /** 有降水的天数占比 0-1 */
  rainRatio: number
  /** 平均日降水量 mm */
  precip: number
  /** 样本总天数 */
  samples: number
  /** 是否雨季（降水日占比 ≥ 40%） */
  rainy: boolean
  /** 穿衣建议 */
  dressing: string
  /** 一句话天气提示 */
  summary: string
  /** 数据来源说明 */
  source: string
  /** 是否为未来精确预报（false 表示常年值） */
  isForecast: boolean
  /**
   * 预报与常年值混用（行程跨过 16 天预报窗口时）
   *
   * 这种情况下卡片不能写「未来 16 天预报」——
   * 实际只有前半段是预报，后半段是往年同月的实测值。
   */
  mixed: boolean
  /**
   * 「降水概率」这个指标是否可用
   *
   * 常年值来自历史实测，没有「概率」这回事 —— 那个位置显示的是
   * 「有雨日占比」（历史上有多少天下过雨）。不区分的话，
   * 会把「往年这 3 天都下过雨」显示成「降水概率 100%」，属于误导。
   */
  probAvailable: boolean
}

/** 天气查询结果 */
export interface WeatherResult extends WeatherInfo {
  /** 逐日明细（按日期升序，行程占用的那几天） */
  daily: DailyWeather[]
}

/** 一条原始日记录 */
interface RawDay {
  /** 预报用未来日期，常年值用真实历史日期 */
  date: string
  high: number
  low: number
  precip: number
  /** 降水概率 %；常年值没有 */
  prob: number | null
}

/** 一批原始记录 */
interface RawBundle {
  days: RawDay[]
  source: string
  isForecast: boolean
}

interface DailyPayload {
  time?: string[]
  temperature_2m_max?: (number | null)[]
  temperature_2m_min?: (number | null)[]
  precipitation_sum?: (number | null)[]
  precipitation_probability_max?: (number | null)[]
}

interface MeteoResponse {
  daily?: DailyPayload
  error?: boolean
  reason?: string
}

/* ------------------------------------------------------------------ *
 * 缓存
 * ------------------------------------------------------------------ */

/**
 * 缓存 key
 *
 * 预报和常年值必须分开缓存：
 * 出发日期在 16 天内时取的是精确预报，用户把日期改到一个月之后
 * 就应该换成常年值 —— 用同一个 key 会把 16 天的预报当成整月天气用。
 *
 * 缓存的是**原始逐日记录**而不是汇总结果，因为汇总依赖行程天数，
 * 原始数据才是不随天数变化的。
 */
/**
 * 缓存 key
 *
 * 预报和常年值必须分开缓存：
 * 出发日期在 16 天内时取的是精确预报，用户把日期改到一个月之后
 * 就应该换成常年值 —— 用同一个 key 会把 16 天的预报当成整月天气用。
 *
 * 预报的 key 里还要带当天日期：预报窗口是「今天 + 15 天」，
 * 每天都在往前挪，不带日期就会出现「昨天的预报当成今天的」。
 */
function cacheKey(
  lat: number,
  lng: number,
  monthKey: string,
  isForecast: boolean
): string {
  const day = isForecast ? todayISO() : ''
  return `${CACHE_PREFIX}${lat.toFixed(2)},${lng.toFixed(2)},${monthKey},${isForecast ? 'f' : 'c'},${day}`
}

function readCache(key: string, ttlMs: number): RawBundle | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const entry = JSON.parse(raw) as { savedAt: number; bundle: RawBundle }
    if (!entry?.bundle?.days?.length) return null
    if (Date.now() - (Number(entry.savedAt) || 0) > ttlMs) {
      localStorage.removeItem(key)
      return null
    }
    return entry.bundle
  } catch {
    return null
  }
}

function writeCache(key: string, bundle: RawBundle): void {
  try {
    localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), bundle }))
  } catch {
    /* localStorage 不可用时静默降级 */
  }
}

/* ------------------------------------------------------------------ *
 * 天气判定
 * ------------------------------------------------------------------ */

/** 按气温和降水给个图标 + 描述 */
function classify(d: { high: number; low: number; precip: number; prob: number | null }): {
  icon: string
  label: string
} {
  const prob = d.prob
  if (d.precip >= 5 || (prob !== null && prob >= 60)) return { icon: '🌧', label: '有雨' }
  if (d.precip >= RAIN_THRESHOLD_MM || (prob !== null && prob >= 25)) {
    return { icon: '🌦', label: '可能有雨' }
  }
  if (prob !== null && prob >= 10) return { icon: '⛅', label: '多云' }
  if (d.low <= 0) return { icon: '❄️', label: '低温' }
  if (d.high >= 32) return { icon: '🔥', label: '高温' }
  return { icon: '☀️', label: '晴' }
}

/** 有降水的天数占比 */
function rainRatioOf(precips: number[]): number {
  if (!precips.length) return 0
  const rainy = precips.filter((p) => p >= RAIN_THRESHOLD_MM).length
  return rainy / precips.length
}

/** 穿衣建议 */
function dressingAdvice(high: number, low: number, rainy: boolean): string {
  const parts: string[] = []
  if (low <= 5) parts.push('厚外套 / 羽绒服')
  else if (low <= 12) parts.push('毛衣 + 外套')
  else if (low <= 18) parts.push('长袖 + 薄外套')
  else if (low <= 24) parts.push('短袖 + 薄外套（早晚凉）')
  else if (high <= 28) parts.push('短袖 / 薄长袖')
  else parts.push('短袖 + 防晒')
  if (high - low >= 10) parts.push('昼夜温差大，带件外套')
  if (rainy) parts.push('记得带伞')
  return parts.join('，')
}

/* ------------------------------------------------------------------ *
 * 请求
 * ------------------------------------------------------------------ */

function createTimeout(ms: number): { signal: AbortSignal; cancel: () => void } {
  try {
    const factory = AbortSignal as unknown as { timeout?: (n: number) => AbortSignal }
    if (typeof factory.timeout === 'function') {
      return { signal: factory.timeout(ms), cancel: () => {} }
    }
  } catch {
    /* 落到兜底实现 */
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  return { signal: controller.signal, cancel: () => clearTimeout(timer) }
}

async function fetchJSON(url: string): Promise<MeteoResponse | null> {
  const { signal, cancel } = createTimeout(REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal, headers: { Accept: 'application/json' } })
    if (!res.ok) return null
    return (await res.json()) as MeteoResponse
  } catch {
    return null
  } finally {
    cancel()
  }
}

/** 把接口返回的 daily 载荷拆成原始记录 */
function toRawDays(daily: DailyPayload | undefined): RawDay[] {
  if (!daily?.time?.length) return []
  const out: RawDay[] = []
  for (let i = 0; i < daily.time.length; i++) {
    const date = daily.time[i]
    const hi = daily.temperature_2m_max?.[i]
    const lo = daily.temperature_2m_min?.[i]
    if (!date || typeof hi !== 'number' || typeof lo !== 'number') continue
    const pb = daily.precipitation_probability_max?.[i]
    out.push({
      date,
      high: hi,
      low: lo,
      precip:
        typeof daily.precipitation_sum?.[i] === 'number'
          ? (daily.precipitation_sum![i] as number)
          : 0,
      prob: typeof pb === 'number' ? pb : null,
    })
  }
  return out
}

/** 未来 16 天的精确预报 */
async function fetchForecastRaw(lat: number, lng: number): Promise<RawBundle | null> {
  const params = [
    `latitude=${lat.toFixed(4)}`,
    `longitude=${lng.toFixed(4)}`,
    'daily=temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max',
    `forecast_days=${FORECAST_DAYS}`,
    'timezone=auto',
  ]
  const data = await fetchJSON(`${FORECAST_ENDPOINT}?${params.join('&')}`)
  const days = toRawDays(data?.daily)
  if (!days.length) return null
  return { days, source: '未来 16 天预报', isForecast: true }
}

/**
 * 最近几年同月的实测常年值
 *
 * @param months 需要哪几个月的样本 —— 行程跨月时要把每个月都取回来，
 *   只取表单里那个「出行月份」会让跨月行程少掉几天数据
 *   （实测：11-30 出发 4 天，常年值只按 12 月取 → 第 1 天没数据 → 后面整体错位）。
 */
async function fetchClimateRaw(
  lat: number,
  lng: number,
  months: number[]
): Promise<RawBundle | null> {
  const now = new Date()
  // 从 3 年前的 1 月 1 日开始，一次请求拿全（ERA5 有滞后，不影响）
  const startYear = now.getFullYear() - (HISTORY_YEARS - 1)
  // 结束日期必须落在过去，否则接口直接 400
  const end = new Date()
  end.setDate(end.getDate() - ERA5_LAG_DAYS)
  const params = [
    `latitude=${lat.toFixed(4)}`,
    `longitude=${lng.toFixed(4)}`,
    'daily=temperature_2m_max,temperature_2m_min,precipitation_sum',
    `start_date=${startYear}-01-01`,
    `end_date=${toISO(end)}`,
    'timezone=auto',
  ]
  const data = await fetchJSON(`${ARCHIVE_ENDPOINT}?${params.join('&')}`)
  const all = toRawDays(data?.daily)
  if (!all.length) return null
  // 只留需要的月份
  const wanted = new Set(months.map((m) => String(m).padStart(2, '0')))
  const days = all.filter((d) => wanted.has(d.date.slice(5, 7)))
  if (!days.length) return null
  const source =
    months.length === 1
      ? `近 ${HISTORY_YEARS} 年 ${months[0]} 月常年值`
      : `近 ${HISTORY_YEARS} 年同月常年值`
  return { days, source, isForecast: false }
}

/* ------------------------------------------------------------------ *
 * 逐日取值
 * ------------------------------------------------------------------ */

/** 从常年值里取某月某日的多年均值 */
function climateFor(raw: RawBundle, dateISO: string): RawDay | null {
  const mmdd = dateISO.slice(5)
  const hits = raw.days.filter((d) => d.date.slice(5) === mmdd)
  if (!hits.length) return null
  const mean = (xs: number[]): number =>
    xs.reduce((s, x) => s + x, 0) / (xs.length || 1)
  return {
    date: dateISO,
    high: mean(hits.map((h) => h.high)),
    low: mean(hits.map((h) => h.low)),
    precip: mean(hits.map((h) => h.precip)),
    prob: null,
  }
}

/** 从预报里取某一天 */
function forecastFor(raw: RawBundle, dateISO: string): RawDay | null {
  return raw.days.find((d) => d.date === dateISO) ?? null
}

/* ------------------------------------------------------------------ *
 * 对外入口
 * ------------------------------------------------------------------ */

/**
 * 取某个目的地在出行时段的天气
 *
 * @param coordinates 目的地坐标，顺序为 [纬度, 经度]（与全站约定一致）
 * @param month       出行月份 1-12
 * @param startDate   出发日期 YYYY-MM-DD；缺省则只用常年值
 * @param days        行程天数（决定逐日明细覆盖哪几天）
 *
 * @returns 天气信息；取不到时返回 null（**永不 throw**）
 */
export async function fetchWeather(
  coordinates: [number, number],
  month: number,
  startDate?: string,
  days = 1
): Promise<WeatherResult | null> {
  try {
    const [lat, lng] = coordinates
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
    if (month < 1 || month > 12) return null

    // 先判断能不能用精确预报：出发日期在未来 16 天内
    //
    // 必须用「纯日期比较」，不能用毫秒差 ——
    // 「今天出发」在凌晨打开和晚上打开会得到不同结论：
    // 毫秒差是「今天零点 − 现在」，凌晨差 1 小时（round 后是 0，判真），
    // 晚上差 23 小时（round 后是 -1，判假），于是晚上打开「今天出发」
    // 会静默退化成常年值。
    let useForecast = false
    if (startDate) {
      const diffDays = daysBetween(todayISO(), startDate)
      useForecast = diffDays >= 0 && diffDays < FORECAST_DAYS
    }

    // 行程实际占用的那几天
    const tripDates: string[] = []
    if (startDate) {
      for (let i = 0; i < Math.max(1, days); i++) tripDates.push(addDays(startDate, i))
    }

    // 常年值要覆盖行程跨越的**每一个**月份。
    // 只按表单里的「出行月份」取，跨月行程就会缺掉几天数据
    // （实测：11-30 出发 4 天，常年值只取 12 月 → 第 1 天没数据 → 后面整体错位）。
    const monthSet = new Set<number>([month])
    for (const d of tripDates) monthSet.add(Number(d.slice(5, 7)))
    const months = [...monthSet].sort((a, b) => a - b)
    const monthKey = months.join('-')

    const load = async (isForecast: boolean): Promise<RawBundle | null> => {
      const key = cacheKey(lat, lng, monthKey, isForecast)
      const cached = readCache(key, isForecast ? FORECAST_TTL_MS : CLIMATE_TTL_MS)
      if (cached) return cached
      const bundle = isForecast
        ? await fetchForecastRaw(lat, lng)
        : await fetchClimateRaw(lat, lng, months)
      if (bundle) writeCache(key, bundle)
      return bundle
    }

    // 预报覆盖范围：今天到今天 + 15 天
    const forecastFrom = todayISO()
    const forecastTo = addDays(forecastFrom, FORECAST_DAYS - 1)
    const coveredByForecast = (d: string): boolean =>
      d >= forecastFrom && d <= forecastTo
    // 预报能覆盖全程时就不用再拉常年值（省一次 ~38KB 的请求）
    const needClimate = !useForecast || tripDates.some((d) => !coveredByForecast(d))

    const forecastRaw = useForecast ? await load(true) : null
    let climateRaw = needClimate ? await load(false) : null
    // 预报没拉到，退回常年值兜底
    if (!forecastRaw && !climateRaw) climateRaw = await load(false)

    // 逐日明细：优先用预报，预报覆盖不到的日期退回常年值
    const daily: DailyWeather[] = []
    if (startDate) {
      for (let i = 0; i < Math.max(1, days); i++) {
        const date = addDays(startDate, i)
        const f = forecastRaw ? forecastFor(forecastRaw, date) : null
        const c = climateRaw ? climateFor(climateRaw, date) : null
        const picked = f ?? c
        if (!picked) continue
        const cls = classify(picked)
        daily.push({
          date,
          high: Math.round(picked.high * 10) / 10,
          low: Math.round(picked.low * 10) / 10,
          precip: Math.round(picked.precip * 10) / 10,
          prob: picked.prob,
          rainy:
            picked.precip >= RAIN_THRESHOLD_MM ||
            (picked.prob !== null && picked.prob >= 40),
          icon: cls.icon,
          label: cls.label,
          source: f ? '预报' : '常年值',
        })
      }
    }

    // 汇总：优先用行程实际占用的那几天；没有逐日数据时退回整个月 / 整个预报窗口
    let highs: number[] = []
    let lows: number[] = []
    let precips: number[] = []
    let probs: number[] = []
    let source = ''
    let isForecast = false
    let mixed = false

    if (daily.length) {
      highs = daily.map((d) => d.high)
      lows = daily.map((d) => d.low)
      precips = daily.map((d) => d.precip)
      probs = daily.filter((d) => d.prob !== null).map((d) => d.prob as number)
      const usesForecast = daily.some((d) => d.source === '预报')
      const usesClimate = daily.some((d) => d.source === '常年值')
      // 混用时不能只报预报 —— 卡片表头会写「未来 16 天预报」，实际有一半是常年值
      mixed = usesForecast && usesClimate
      source = mixed
        ? '预报 + 常年值'
        : usesForecast
          ? forecastRaw?.source ?? '未来 16 天预报'
          : climateRaw?.source ?? `近 ${HISTORY_YEARS} 年 ${month} 月常年值`
      isForecast = usesForecast && !usesClimate
    } else if (climateRaw) {
      highs = climateRaw.days.map((d) => d.high)
      lows = climateRaw.days.map((d) => d.low)
      precips = climateRaw.days.map((d) => d.precip)
      source = climateRaw.source
    } else if (forecastRaw) {
      highs = forecastRaw.days.map((d) => d.high)
      lows = forecastRaw.days.map((d) => d.low)
      precips = forecastRaw.days.map((d) => d.precip)
      probs = forecastRaw.days.filter((d) => d.prob !== null).map((d) => d.prob as number)
      source = forecastRaw.source
      isForecast = true
    }

    if (!highs.length || !lows.length) return null

    const mean = (xs: number[]): number =>
      xs.reduce((s, x) => s + x, 0) / (xs.length || 1)
    const high = mean(highs)
    const low = mean(lows)
    const precip = precips.length ? mean(precips) : 0

    // 「降水概率」只有在**每一天都有概率数据**时才成立。
    // 预报与常年值混用时（行程跨过 16 天窗口）只取预报的概率算平均值，
    // 会让「有 2 天下雨」的三天行程显示成「降水概率 5%」——
    // 概率是那两天的均值，被摊到了四天头上。
    const allHaveProb = daily.length > 0 && daily.every((d) => d.prob !== null)
    const rainRatio = allHaveProb
      ? probs.reduce((s, p) => s + p, 0) / (probs.length || 1) / 100
      : rainRatioOf(precips)
    const rainy = rainRatio >= 0.4
    // 有雨天数直接数，别拿「概率均值 × 总天数」硬凑
    const rainyDays = daily.length
      ? daily.filter((d) => d.rainy).length
      : Math.round(rainRatio * (highs.length || 0))

    return {
      high: Math.round(high * 10) / 10,
      low: Math.round(low * 10) / 10,
      rainRatio: Math.round(rainRatio * 100) / 100,
      precip: Math.round(precip * 10) / 10,
      samples: highs.length,
      rainy,
      dressing: dressingAdvice(high, low, rainy),
      summary: `${highs.length} 天样本 · ${rainyDays} 天有降水（日均 ${precip.toFixed(1)} mm）`,
      source,
      isForecast,
      mixed,
      probAvailable: allHaveProb,
      daily,
    }
  } catch {
    return null
  }
}

/**
 * 清掉某个目的地的天气缓存（预报与常年值一起清）
 *
 * 缓存 key 里带了月份、日期与口径，没法逐条列出来 ——
 * 按「坐标前缀」清，把这个目的地所有口径的缓存一次性清掉。
 */
export function clearWeatherCache(coordinates: [number, number]): void {
  try {
    const prefix = `${CACHE_PREFIX}${coordinates[0].toFixed(2)},${coordinates[1].toFixed(2)},`
    const doomed: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(prefix)) doomed.push(k)
    }
    for (const k of doomed) localStorage.removeItem(k)
  } catch {
    /* ignore */
  }
}

/** 今天（导出用） */
export { todayISO }
