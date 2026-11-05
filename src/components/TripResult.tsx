import { useMemo, useState } from 'react'
import { HOTEL_TIER_LABELS, TIME_SLOT_LABELS, TRANSIT_LABELS, type CityPack } from '../data/types'
import { findOrigin } from '../data/origins'
import { estimateFares, ticketQueryUrl } from '../engine/fare'
import { haversine } from '../engine/geo'
import type { DayPlan, TripPlan } from '../engine/itinerary'
import { buildPlanEvents, icsFileName } from '../engine/calendar'
import { buildICS, downloadICS } from '../utils/ics'
import { PhotoGallery, useCityPhotos } from './PhotoGallery'
import { TripMap } from './TripMap'

const MODE_ICON: Record<string, string> = {
  walk: '🚶',
  metro: '🚇',
  bus: '🚌',
  taxi: '🚕',
  bike: '🚲',
  car: '🚗',
}

const BUDGET_COLORS = ['#4ade80', '#38bdf8', '#a78bfa', '#fbbf24', '#f472b6']

/** 当前年月（模块加载时取一次，避免在渲染期调用 Date） */
const NOW_YEAR = new Date().getFullYear()
const NOW_MONTH = new Date().getMonth() + 1

export function TripResult({
  plan,
  pack,
}: {
  plan: TripPlan
  pack: CityPack
}) {
  const { city } = pack

  // 导出 .ics 的临时反馈状态
  const [icsState, setIcsState] = useState<'idle' | 'ok' | 'err'>('idle')

  const exportICS = () => {
    const startDate = plan.request.startDate
    const events = buildPlanEvents(plan)
    if (!startDate || !events.length) {
      setIcsState('err')
      window.setTimeout(() => setIcsState('idle'), 2600)
      return
    }
    const content = buildICS(events, `${city.name} · ${plan.request.days} 天行程`)
    downloadICS(content, icsFileName(city.name, startDate))
    setIcsState('ok')
    window.setTimeout(() => setIcsState('idle'), 2200)
  }

  // 目的地实景图（检索失败静默降级，不影响主流程）
  const attractionNames = useMemo(
    () => pack.attractions.map((a) => a.name),
    [pack]
  )
  const { photos, loading: photosLoading } = useCityPhotos(
    city.name,
    city.enName,
    attractionNames
  )

  // 大交通票价参考：按出发地到目的地的直线距离给出「单程 · 单人」票价区间
  const originCity = plan.request.origin ? findOrigin(plan.request.origin) : null
  const straightKm =
    originCity && city.coordinates
      ? Math.round(haversine(originCity.coordinates, city.coordinates))
      : null

  // 查票链接上的日期：优先用真实出发日期，退回到「该月份中旬」
  const fareDate = useMemo(() => {
    if (plan.request.startDate) return plan.request.startDate
    const m = plan.request.month
    const y = m >= NOW_MONTH ? NOW_YEAR : NOW_YEAR + 1
    return `${y}-${String(m).padStart(2, '0')}-15`
  }, [plan.request.startDate, plan.request.month])

  const fares = straightKm
    ? estimateFares({
        fromCity: plan.request.origin,
        toCity: city.name,
        km: straightKm,
        overseas: city.overseas,
        month: plan.request.month,
        dateISO: fareDate,
      })
    : []

  return (
    <>
      {/* ---------- 概览 ---------- */}
      <div className="hero">
        {photos[0] && (
          <div
            className="hero-bg"
            style={{ backgroundImage: `url("${photos[0].url}")` }}
          />
        )}
        <h1>
          {city.name} · {plan.request.days} 天
        </h1>
        <div className="hero-tag">
          {city.tagline} · {city.enName}
        </div>
        <div className="hero-desc">{city.intro}</div>

        <div className="hero-stats">
          <div className="stat">
            <div className="stat-k">人均预算</div>
            <div className="stat-v">{plan.perPersonBudget.toLocaleString()}</div>
          </div>
          <div className="stat">
            <div className="stat-k">日均预算</div>
            <div className="stat-v">{plan.perDayBudget.toLocaleString()}</div>
          </div>
          <div className="stat">
            <div className="stat-k">推荐住宿片区</div>
            <div className="stat-v plain">{plan.lodging.hotel.zone || '—'}</div>
          </div>
          <div className="stat">
            <div className="stat-k">行程覆盖景点</div>
            <div className="stat-v plain">
              {plan.days.reduce((s, d) => s + d.items.length, 0)} 个
            </div>
          </div>
        </div>

        <div className="highlights">
          {city.highlights.map((h, i) => (
            <div className="highlight-item" key={i}>
              <span className="dot">▸</span>
              <span>{h}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ---------- 路线图 ---------- */}
      <TripMap plan={plan} pack={pack} />

      {/* ---------- 目的地实景 ---------- */}
      {(photos.length > 0 || photosLoading) && (
        <div className="card">
          <div className="card-head">
            <div className="card-icon">📷</div>
            <div className="card-title">目的地实景</div>
            <div className="card-sub">
              {photosLoading ? '加载中…' : `${photos.length} 张 · Wikimedia Commons`}
            </div>
          </div>
          <PhotoGallery photos={photos} loading={photosLoading} />
        </div>
      )}

      {/* ---------- 最佳出行窗口 ---------- */}
      <div className="card">
        <div className="card-head">
          <div className="card-icon">🗓</div>
          <div className="card-title">出行时机</div>
        </div>
        <div style={{ fontSize: 14, lineHeight: 1.75, color: 'var(--text-dim)' }}>
          {plan.bestWindow}
        </div>
        <div
          style={{
            fontSize: 12.5,
            color: 'var(--text-faint)',
            marginTop: 8,
            lineHeight: 1.6,
          }}
        >
          {city.climate}
        </div>
        <div className="tag-cloud" style={{ marginTop: 12 }}>
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
            <span
              key={m}
              className={`tag-chip${m === plan.request.month ? ' on' : ''}`}
              style={
                city.bestMonths.includes(m) && m !== plan.request.month
                  ? { borderColor: 'rgba(74,222,128,0.35)', color: 'var(--accent)' }
                  : undefined
              }
            >
              {m}月
            </span>
          ))}
        </div>
      </div>

      {/* ---------- 交通方案 ---------- */}
      <div className="card">
        <div className="card-head">
          <div className="card-icon">🚄</div>
          <div className="card-title">交通方案</div>
          <div className="card-sub">
            {plan.request.origin
              ? `从${plan.request.origin}出发`
              : '未指定出发地'}
          </div>
        </div>
        <div className="transport-grid">
          <div className="transport-box">
            <div className="tk">抵达方式</div>
            <div className="tv">{plan.transitPlan.arrival.mode}</div>
            <div className="tn">{plan.transitPlan.arrival.note}</div>
            <div className="tn" style={{ marginTop: 6, color: 'var(--accent)' }}>
              往返预估 {plan.transitPlan.arrival.cost.toLocaleString()} 元 ·{' '}
              {plan.transitPlan.arrival.duration}
            </div>
          </div>
          <div className="transport-box">
            <div className="tk">离开方式</div>
            <div className="tv">{plan.transitPlan.departure.mode}</div>
            <div className="tn">{plan.transitPlan.departure.note}</div>
          </div>
          <div className="transport-box">
            <div className="tk">市内主推交通</div>
            <div className="tv">
              {MODE_ICON[plan.transitPlan.cityTransit.mode]}{' '}
              {plan.transitPlan.cityTransit.label}
            </div>
            <div className="tn">{plan.transitPlan.cityTransit.note}</div>
            <div className="tn" style={{ marginTop: 6, color: 'var(--accent)' }}>
              约 {plan.transitPlan.cityTransit.dailyCost} 元/人/天
            </div>
          </div>
        </div>

        {fares.length > 0 && (
          <div className="fare-block">
            <div className="fare-head">
              大交通票价参考
              <span className="fare-sub">
                单程 · 单人 · 直线 {straightKm?.toLocaleString()} km
              </span>
            </div>
            <div className="fare-list">
              {fares.map((f) => (
                <div className="fare-row" key={`${f.mode}-${f.seat}`}>
                  <div className="fare-left">
                    <span className="fare-mode">
                      {f.label} · {f.seat}
                    </span>
                    {f.note && <span className="fare-hint">{f.note}</span>}
                  </div>
                  <div className="fare-right">
                    <span className="fare-price">
                      {f.low === f.high ? f.low : `${f.low}–${f.high}`} 元
                    </span>
                    <a
                      className="fare-link"
                      href={f.queryUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {f.queryName} ↗
                    </a>
                  </div>
                </div>
              ))}
            </div>
            <div className="fare-foot">
              以上为按里程推算的<b>量级区间</b>，不是实时票价。12306 没有公开接口、
              也不允许浏览器跨域直连，纯前端拿不到真实票价 —— 点右侧链接到官方平台查实时价。
            </div>
          </div>
        )}
      </div>

      {/* ---------- 每日行程 ---------- */}
      <div className="card">
        <div className="card-head">
          <div className="card-icon">🗺</div>
          <div className="card-title">每日路线</div>
          <div className="card-sub">共 {plan.days.length} 天</div>
          <button
            className="btn btn-ghost ics-btn"
            onClick={exportICS}
            title="导出 .ics 文件，可导入手机日历 / Outlook / Google Calendar"
          >
            {icsState === 'ok'
              ? '✓ 已导出日历'
              : icsState === 'err'
                ? '请先填出发日期'
                : '导出日历 .ics'}
          </button>
        </div>
        {plan.days.map((day) => (
          <DayView key={day.day} day={day} />
        ))}
      </div>

      {/* ---------- 住宿 ---------- */}
      <div className="card">
        <div className="card-head">
          <div className="card-icon">🏨</div>
          <div className="card-title">建议住宿</div>
          <div className="card-sub">
            {plan.lodging.nights} 晚 ·{' '}
            {HOTEL_TIER_LABELS[plan.lodging.hotel.tier ?? 'comfort']}
          </div>
        </div>
        {plan.lodging.hotel.name ? (
          <>
            <div className="stay-main">
              <div>
                <div className="stay-name">{plan.lodging.hotel.name}</div>
                <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>
                  {plan.lodging.hotel.desc}
                </div>
                <div className="tag-cloud" style={{ marginTop: 8 }}>
                  {plan.lodging.hotel.tags.map((t) => (
                    <span className="pill" key={t}>
                      {t}
                    </span>
                  ))}
                  <span className="pill">评分 {plan.lodging.hotel.rating}</span>
                </div>
              </div>
              <div className="stay-price">
                {plan.lodging.hotel.price}
                <small> 元/晚</small>
                <div style={{ fontSize: 12, color: 'var(--text-faint)', fontWeight: 400 }}>
                  合计 {plan.lodging.totalCost.toLocaleString()} 元
                </div>
              </div>
            </div>
            <div className="stay-reason">{plan.lodging.reason}</div>
            {plan.lodging.alternatives.length > 0 && (
              <>
                <div
                  style={{
                    fontSize: 12.5,
                    color: 'var(--text-faint)',
                    margin: '14px 0 8px',
                    fontWeight: 600,
                  }}
                >
                  其他备选
                </div>
                <div className="alt-hotels">
                  {plan.lodging.alternatives.map((h) => (
                    <div className="alt-hotel" key={h.id}>
                      <div className="n">{h.name}</div>
                      <div className="p">
                        {h.price} 元/晚 · {HOTEL_TIER_LABELS[h.tier]}
                      </div>
                      <div
                        style={{
                          fontSize: 11.5,
                          color: 'var(--text-faint)',
                          marginTop: 3,
                        }}
                      >
                        {h.zone}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        ) : (
          <div style={{ color: 'var(--text-faint)' }}>暂无住宿数据</div>
        )}
      </div>

      {/* ---------- 预算 ---------- */}
      <div className="card">
        <div className="card-head">
          <div className="card-icon">💰</div>
          <div className="card-title">预算分配</div>
          <div className="card-sub">
            合计 {plan.totalBudget.toLocaleString()} 元
          </div>
        </div>
        <div className="budget-list">
          {plan.budgetItems.map((b, i) => (
            <div className="budget-row" key={b.key}>
              <div className="budget-label">{b.label}</div>
              <div className="budget-bar">
                <div
                  className="budget-fill"
                  style={{
                    width: `${Math.min(100, b.ratio * 100)}%`,
                    background: BUDGET_COLORS[i % BUDGET_COLORS.length],
                  }}
                />
              </div>
              <div className="budget-amt">{b.amount.toLocaleString()} 元</div>
              <div className="budget-detail">{b.detail}</div>
            </div>
          ))}
        </div>
        <div
          style={{
            marginTop: 16,
            paddingTop: 14,
            borderTop: '1px solid var(--border-soft)',
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: 13.5,
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          <span style={{ color: 'var(--text-dim)' }}>
            按行程实际估算的花费合计
          </span>
          <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--accent)' }}>
            {plan.estimatedCost.toLocaleString()} 元
          </span>
        </div>
      </div>

      {/* ---------- 美食 ---------- */}
      {pack.foods.length > 0 && (
        <div className="card">
          <div className="card-head">
            <div className="card-icon">🍜</div>
            <div className="card-title">必吃清单</div>
            <div className="card-sub">{pack.foods.length} 种</div>
          </div>
          <div className="food-grid">
            {pack.foods.map((f) => (
              <div className="food-item" key={f.name}>
                <div className="food-name">
                  {f.name}
                  {f.price && <span className="food-price">{f.price}</span>}
                </div>
                <div className="food-desc">{f.desc}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ---------- 贴士 ---------- */}
      <div className="card">
        <div className="card-head">
          <div className="card-icon">💡</div>
          <div className="card-title">实用贴士</div>
        </div>
        <div className="tip-list">
          {plan.tips.map((t, i) => (
            <div className="tip-item" key={i}>
              <span style={{ flexShrink: 0 }}>▸</span>
              <span>{t}</span>
            </div>
          ))}
          {plan.warnings.map((w, i) => (
            <div className="tip-item warn-item" key={`w${i}`}>
              <span style={{ flexShrink: 0 }}>⚠</span>
              <span>{w}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

function DayView({ day }: { day: DayPlan }) {
  // 餐点和景点按开始时间混排 —— 餐点落在当天的真实空档里，
  // 所以直接按时间排序就是用户实际要走的时间顺序
  const timeline = [
    ...day.items.map((item) => ({ kind: 'spot' as const, time: item.startTime, item })),
    ...day.meals.map((meal) => ({ kind: 'meal' as const, time: meal.startTime, meal })),
  ].sort((a, b) => a.time.localeCompare(b.time))

  if (!timeline.length) {
    return (
      <div className="day">
        <div className="day-head">
          <div className="day-num">{day.day}</div>
          <div className="day-zone">{day.title}</div>
          <div className="day-meta">
            <span>自由安排</span>
          </div>
        </div>
        <div className="day-body">
          <div className="day-note" style={{ margin: '4px 0 12px' }}>
            {day.note}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="day">
      <div className="day-head">
        <div className="day-num">{day.day}</div>
        <div className="day-zone">{day.title}</div>
        {day.weather && (
          <div
            className="day-weather"
            title={`${day.weather.label} · 降水概率 ${
              day.weather.prob === null ? '—' : day.weather.prob + '%'
            } · ${day.weather.source}`}
          >
            <span className="dw-icon">{day.weather.icon}</span>
            <span className="dw-temp">
              {Math.round(day.weather.high)}°/{Math.round(day.weather.low)}°
            </span>
            <span className="dw-src">{day.weather.source}</span>
          </div>
        )}
        <div className="day-meta">
          <span title="景点游玩 + 路上时间（不含吃饭与休息）">
            共 <b>{day.hours}</b> h
          </span>
          <span>
            门票 <b>{day.ticketCost}</b> 元
          </span>
          <span>
            交通 <b>{day.transitCost}</b> 元
          </span>
          {day.foodCost > 0 && (
            <span>
              餐饮 <b>{day.foodCost}</b> 元
            </span>
          )}
        </div>
      </div>
      <div className="day-body">
        {timeline.map((entry, i) => {
          if (entry.kind === 'meal') {
            const meal = entry.meal
            return (
              <div className="meal-row" key={`meal-${meal.slot}-${meal.name}`}>
                <div className="meal-time">
                  {meal.startTime}
                  <small>{meal.endTime}</small>
                </div>
                <div className="meal-main">
                  <div className="meal-name">
                    {meal.label} · {meal.name}
                  </div>
                  <div className="meal-desc">{meal.desc}</div>
                  <div className="meal-meta">
                    {meal.zone && <span className="pill">{meal.zone}</span>}
                    <span className="pill meal-cost">人均 {meal.cost} 元</span>
                  </div>
                </div>
              </div>
            )
          }
          const item = entry.item
          return (
          <div key={item.attraction.id}>
            {item.transit && (
              <div className="leg">
                <span className="leg-icon">
                  {MODE_ICON[item.transit.mode]}{' '}
                  {TRANSIT_LABELS[item.transit.mode]}
                </span>
                <span>{item.transit.minutes} 分钟</span>
                <span>· {item.transit.distanceKm} km</span>
                <span>· {item.transit.cost} 元</span>
              </div>
            )}
            <div className="stop">
              <div className="stop-rail">
                <div className="stop-time">
                  {item.startTime}
                  <small>{item.endTime}</small>
                </div>
                <div className="stop-dot" />
                {i < timeline.length - 1 && <div className="stop-line" />}
              </div>
              <div className="stop-main">
                <div className="stop-name">
                  {item.attraction.name}
                  {item.picked && <span className="pill pick">你选的</span>}
                  {item.attraction.signature && <span className="pill sig">必去</span>}
                </div>
                <div className="stop-desc">{item.attraction.desc}</div>
                {item.attraction.tip && (
                  <div className="stop-tip">💡 {item.attraction.tip}</div>
                )}
                <div className="stop-meta">
                  <span className="pill">
                    {TIME_SLOT_LABELS[item.attraction.bestTime]}
                  </span>
                  <span className="pill">建议 {item.attraction.hours} 小时</span>
                  {item.attraction.ticket > 0 ? (
                    <a
                      className="pill ticket"
                      href={ticketQueryUrl(item.attraction.name)}
                      target="_blank"
                      rel="noreferrer noopener"
                      title="搜索该景点的实时票价与购票入口"
                    >
                      门票 {item.attraction.ticket} 元 ↗
                    </a>
                  ) : (
                    <span className="pill ticket">免费</span>
                  )}
                  <span className="pill">{item.attraction.openTime}</span>
                  <span className="pill">评分 {item.attraction.rating}</span>
                </div>
              </div>
            </div>
          </div>
          )
        })}
      </div>
      {day.note && (
        <div className="day-note" style={{ margin: '0 0 14px' }}>
          {day.note}
        </div>
      )}
    </div>
  )
}
