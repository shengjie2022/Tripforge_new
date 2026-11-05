import { useEffect, useMemo, useState } from 'react'
import { getCityPack } from './data'
import { findOrigin } from './data/origins'
import { ALL_TAGS, type BudgetStyle, type CityPack, type Pace, type Tag } from './data/types'
import { generateTrip, type TripRequest } from './engine/itinerary'
import { haversine } from './engine/geo'
import { defaultStartDate, parseISO } from './utils/date'
import { CityPicker, OriginPicker, parseAICityId } from './components/CityPicker'
import { AttractionBoard } from './components/AttractionBoard'
import { TripForm } from './components/TripForm'
import { TripResult } from './components/TripResult'
import { AIEnhance } from './components/AIEnhance'
import { AICitySetup } from './components/AICitySetup'
import { WeatherCard, useWeather } from './components/WeatherCard'
import './styles.css'

const DEFAULTS: TripRequest = {
  cityId: 'chengdu',
  origin: '上海',
  days: 4,
  budget: 6000,
  travelers: 2,
  style: 'balanced',
  pace: 'balanced',
  month: Number(defaultStartDate().slice(5, 7)),
  prefs: ['food', 'history'],
  includeTransport: true,
  startDate: defaultStartDate(),
}

/**
 * URL 里的出发日期归一化
 *
 * start 参数是用户可编辑的（手改链接就能塞进任意字符串），
 * 非法值必须在这里挡掉 —— 否则日期标签会变成「第 1 天 · （）」。
 */
function normalizeStartDate(raw: string | null): string {
  const v = raw?.trim()
  if (raw === '') return ''
  if (v && parseISO(v)) return v
  return DEFAULTS.startDate ?? defaultStartDate()
}

/**
 * 从 URL 取一个白名单内的枚举值
 *
 * 这些参数是用户可编辑的（手改链接就能塞进任意字符串），必须挡住：
 *   - 非法 style → BUDGET_RATIO[style] 取到 undefined → 读 ratio.stay 直接抛错，整页白屏；
 *   - 非法 pace  → SPOTS_PER_DAY[pace] 取到 undefined → `x > undefined` 恒为 false，
 *     每天点数与时长上限全部静默失效。
 */
function pickEnum<T extends string>(raw: string | null, allowed: T[], fallback: T): T {
  return raw && (allowed as string[]).includes(raw) ? (raw as T) : fallback
}

/** 合法的风格 / 节奏取值 */
const STYLES: BudgetStyle[] = ['thrifty', 'balanced', 'premium']
const PACES: Pace[] = ['packed', 'balanced', 'relaxed']

function loadFromUrl(): TripRequest {
  const p = new URLSearchParams(window.location.search)
  /**
   * 从 URL 取一个正整数
   *
   * 必须是整数：`?d=3.5` 这种小数会让引擎的 Array.from({length}) 与循环边界对不上，
   * 直接抛错白屏（而且项目里没有 ErrorBoundary，整棵树会卸载）。
   */
  const num = (k: string, d: number, min = 1, max = Number.MAX_SAFE_INTEGER) => {
    const v = Number(p.get(k))
    if (!Number.isFinite(v)) return d
    const n = Math.round(v)
    return n >= min && n <= max ? n : d
  }
  const rawPrefs = p.get('prefs')
  const startDate = normalizeStartDate(p.get('start'))
  const parsedStart = parseISO(startDate)
  return {
    cityId: p.get('city') || DEFAULTS.cityId,
    origin: p.get('from') || DEFAULTS.origin,
    days: num('d', DEFAULTS.days, 1, 15),
    budget: num('b', DEFAULTS.budget, 1000, 80000),
    travelers: num('p', DEFAULTS.travelers, 1, 10),
    style: pickEnum(p.get('s'), STYLES, DEFAULTS.style),
    pace: pickEnum(p.get('pace'), PACES, DEFAULTS.pace),
    month: parsedStart ? parsedStart.getMonth() + 1 : num('m', DEFAULTS.month, 1, 12),
    prefs:
      rawPrefs === null
        ? DEFAULTS.prefs
        : (rawPrefs.split(',').filter((t) => (ALL_TAGS as string[]).includes(t)) as Tag[]),
    includeTransport: p.get('t') !== '0',
    startDate,
    mustVisit: p.get('spots')?.split(',').filter(Boolean) ?? [],
    onlyMustVisit: p.get('only') === '1',
  }
}

export default function App() {
  const [req, setReq] = useState<TripRequest>(loadFromUrl)
  const [copied, setCopied] = useState(false)
  /** 大模型生成的任意城市资料包 */
  const [aiPack, setAiPack] = useState<CityPack | null>(null)

  const aiCityName = parseAICityId(req.cityId)

  // 内置城市包
  const builtinPack = useMemo(() => getCityPack(req.cityId), [req.cityId])

  // 实际使用的包：AI 城市用生成结果，内置城市用静态数据
  const pack = useMemo<CityPack | null>(() => {
    if (aiCityName) {
      // 只认同一个城市的结果，避免切换城市后串用
      return aiPack && aiPack.city.name === aiCityName ? aiPack : null
    }
    return builtinPack ?? null
  }, [aiCityName, aiPack, builtinPack])

  // 点选里可能混着失效的 id：换过城市、或 AI 城市重新生成后 id 会变。
  // 引擎、榜单、URL 三处统一只认「当前城市真实存在」的景点，
  // 否则提示条会显示「已选 N 个」却一个都点不掉。
  const validMustVisit = useMemo(() => {
    const cur = req.mustVisit ?? []
    // pack 还没出来（AI 城市尚未生成），先原样保留，别把选择弄丢
    if (!pack) return cur
    const valid = new Set(pack.attractions.map((a) => a.id))
    const kept = cur.filter((id) => valid.has(id))
    return kept.length === cur.length ? cur : kept
  }, [pack, req.mustVisit])

  // 目的地天气：雨季会把选点往室内场馆带
  const coords = pack?.city.coordinates
  const { info: weather, daily: dailyWeather, loading: weatherLoading } = useWeather(
    coords?.[0],
    coords?.[1],
    req.month,
    req.startDate,
    req.days
  )

  // 真正用于生成行程的条件
  const effectiveReq = useMemo(
    () => ({
      ...req,
      mustVisit: validMustVisit,
      rainy: weather?.rainy === true,
      dailyWeather: dailyWeather.length ? dailyWeather : undefined,
    }),
    [req, validMustVisit, weather, dailyWeather]
  )

  const plan = useMemo(() => {
    if (!pack) return null
    return generateTrip(pack, effectiveReq)
  }, [pack, effectiveReq])

  // 室内场馆的两个数：城市里的「数据上限」与这趟行程的「实际兑现」。
  // 天气卡片要按实际排进去的数量说话，不能笼统承诺「雨季优先安排室内」。
  const indoorTotal = useMemo(
    () =>
      pack
        ? pack.attractions.filter((a) => a.indoor || a.tags.includes('indoor')).length
        : 0,
    [pack]
  )
  const indoorPlaced = useMemo(
    () =>
      plan
        ? plan.days
            .flatMap((d) => d.items)
            .filter((i) => i.attraction.indoor || i.attraction.tags.includes('indoor')).length
        : 0,
    [plan]
  )

  // 同步到 URL，方便分享
  useEffect(() => {
    const p = new URLSearchParams()
    p.set('city', req.cityId)
    if (req.origin) p.set('from', req.origin)
    p.set('d', String(req.days))
    p.set('b', String(req.budget))
    p.set('p', String(req.travelers))
    p.set('s', req.style)
    p.set('pace', req.pace)
    p.set('m', String(req.month))
    p.set('prefs', req.prefs.join(','))
    if (!req.includeTransport) p.set('t', '0')
    p.set('start', req.startDate ?? '')
    if (validMustVisit.length) p.set('spots', validMustVisit.join(','))
    if (req.onlyMustVisit) p.set('only', '1')
    window.history.replaceState(null, '', `?${p.toString()}${window.location.hash}`)
  }, [req, validMustVisit])

  const patch = (part: Partial<TripRequest>) => setReq((r) => ({ ...r, ...part }))

  // 景点好评榜：点一下就加入 / 移出我的路线
  const toggleSpot = (id: string) => {
    setReq((r) => {
      const cur = r.mustVisit ?? []
      return {
        ...r,
        mustVisit: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id],
      }
    })
  }
  const clearSpots = () => patch({ mustVisit: [] })

  const share = async () => {
    const url = window.location.href
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      window.prompt('复制这个链接分享给朋友：', url)
    }
  }

  const print = () => window.print()

  // 出发地与目的地的直线距离，用于交通方案提示
  const originInfo = useMemo(() => {
    if (!pack) return null
    const coords = pack.city.coordinates
    if (!coords) return null
    const o = findOrigin(req.origin)
    if (!o) return null
    const km = Math.round(haversine(o.coordinates, coords))
    return { km, city: o.name }
  }, [req.origin, pack])

  const originHint = originInfo && pack ? (
    <div
      style={{
        fontSize: 12.5,
        color: 'var(--text-faint)',
        padding: '0 2px',
      }}
    >
      📍 {originInfo.city} → {pack.city.name} 直线约{' '}
      {originInfo.km.toLocaleString()} km
      {pack.city.overseas
        ? ' · 需国际航班'
        : originInfo.km > 1200
          ? ' · 建议直飞'
          : originInfo.km > 500
            ? ' · 高铁或直飞均可'
            : ' · 高铁优先'}
    </div>
  ) : null

  // 景点好评榜：内置城市和 AI 城市都有景点数据，共用这一块
  const boardBlock = pack ? (
    <AttractionBoard
      pack={pack}
      request={effectiveReq}
      selected={validMustVisit}
      onToggle={toggleSpot}
      onClear={clearSpots}
      onlySelected={req.onlyMustVisit === true}
      onOnlySelected={(v) => patch({ onlyMustVisit: v })}
    />
  ) : null

  // 行程主体：AI 城市与内置城市共用同一段渲染
  const tripBlock = plan && pack ? (
    <>
      {originInfo && originHint}
      <WeatherCard
        cityName={pack.city.name}
        info={weather}
        daily={dailyWeather}
        loading={weatherLoading}
        indoorTotal={indoorTotal}
        indoorPlaced={indoorPlaced}
      />
      <TripResult plan={plan} pack={pack} />
      <AIEnhance key={JSON.stringify(effectiveReq)} plan={plan} pack={pack} />
    </>
  ) : null

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">✈</span>
          <span>
            行迹 · TripForge
            <small>输入条件，自动生成可执行的旅行方案</small>
          </span>
        </div>
        <div className="topbar-actions">
          <button className="btn btn-ghost" onClick={print}>
            打印 / 存 PDF
          </button>
          <button className="btn" onClick={share}>
            {copied ? '✓ 链接已复制' : '复制分享链接'}
          </button>
        </div>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <CityPicker
            value={req.cityId}
            onChange={(id) => patch({ cityId: id, mustVisit: [] })}
          />
          <OriginPicker
            value={req.origin}
            onChange={(v) => patch({ origin: v })}
          />
          <TripForm
            days={req.days}
            onDays={(v) => patch({ days: v })}
            budget={req.budget}
            onBudget={(v) => patch({ budget: v })}
            travelers={req.travelers}
            onTravelers={(v) => patch({ travelers: v })}
            style={req.style}
            onStyle={(v) => patch({ style: v })}
            pace={req.pace}
            onPace={(v) => patch({ pace: v })}
            month={req.month}
            onMonth={(v) => {
              const date = req.startDate ? parseISO(req.startDate) : null
              if (date) {
                const day = Math.min(date.getDate(), new Date(date.getFullYear(), v, 0).getDate())
                patch({ month: v, startDate: `${date.getFullYear()}-${String(v).padStart(2, '0')}-${String(day).padStart(2, '0')}` })
              } else patch({ month: v })
            }}
            prefs={req.prefs}
            onPrefs={(v) => patch({ prefs: v })}
            includeTransport={req.includeTransport}
            onIncludeTransport={(v) => patch({ includeTransport: v })}
            startDate={req.startDate ?? ''}
            onStartDate={(v) => {
              const date = parseISO(v)
              patch({ startDate: v, ...(date ? { month: date.getMonth() + 1 } : {}) })
            }}
          />
          <div className="form-foot">
            <button
              className="btn btn-primary"
              onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
            >
              已生成 · 查看方案 ↓
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => {
                setReq(DEFAULTS)
                setAiPack(null)
              }}
            >
              重置为默认条件
            </button>
          </div>
        </aside>

        <main className="main">
          {aiCityName ? (
            <>
              {/* AI 城市：资料面板常驻，生成后仍可查看 / 重新生成 */}
              <AICitySetup
                key={aiCityName}
                cityName={aiCityName}
                request={req}
                current={aiPack && aiPack.city.name === aiCityName ? aiPack : null}
                onGenerated={setAiPack}
              />
              {boardBlock}
              {tripBlock}
            </>
          ) : (
            <>
              {boardBlock}
              {tripBlock ?? (
                <div className="card">
                  <div className="empty">
                    <div className="empty-icon">🧭</div>
                    <h3>还没有选择目的地</h3>
                    <p>在左侧选择一个城市，右侧会立刻生成逐日路线图、交通方式与住宿建议。</p>
                  </div>
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  )
}
