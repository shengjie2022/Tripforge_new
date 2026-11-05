import { useEffect, useState } from 'react'
import { fetchWeather, type WeatherInfo } from '../api/weather'
import type { DailyWeather } from '../data/types'

/**
 * 天气卡片 + 取数 hook
 *
 * 失败一律静默降级（返回 null → 卡片不渲染），绝不挡住攻略主流程。
 */

/** 拉取目的地天气 */
export function useWeather(
  lat: number | undefined,
  lng: number | undefined,
  month: number,
  startDate: string | undefined,
  days: number
): { info: WeatherInfo | null; daily: DailyWeather[]; loading: boolean } {
  // 请求指纹：目的地 + 月份 + 出发日期 + 天数
  const key = `${lat ?? ''},${lng ?? ''},${month},${startDate ?? ''},${days}`
  const [state, setState] = useState<{
    key: string
    info: WeatherInfo | null
    daily: DailyWeather[]
  }>({ key: '', info: null, daily: [] })
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (lat === undefined || lng === undefined || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      setState({ key, info: null, daily: [] })
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    fetchWeather([lat, lng], month, startDate, days)
      .then((r) => {
        if (!alive) return
        setState({ key, info: r, daily: r?.daily ?? [] })
        setLoading(false)
      })
      .catch(() => {
        if (!alive) return
        setState({ key, info: null, daily: [] })
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [lat, lng, month, startDate, days, key])

  // 只有指纹对得上才把数据交出去 ——
  // 否则切城市的那一瞬间，上一个城市的天气还会参与新城市的选点
  // （旧城市的 rainy 标记会改变新城市的景点选择）
  const current = state.key === key
  return { info: current ? state.info : null, daily: current ? state.daily : [], loading }
}

/** 按降水情况挑个图标（整趟概览用） */
function overviewIcon(info: WeatherInfo): string {
  if (info.rainRatio >= 0.4) return '🌧'
  if (info.rainRatio >= 0.15) return '🌦'
  if (info.high >= 30) return '🔥'
  if (info.low <= 5) return '❄️'
  return '☀️'
}

/** 「11 月 5 日」 */
function shortDate(iso: string): string {
  const [, m, d] = iso.split('-')
  return `${Number(m)}/${Number(d)}`
}

/**
 * 雨季提示 —— 只说做得到的事
 *
 * 引擎在雨季确实会给室内场馆加分，但一座城市能避雨的场馆本身常常只有 1-2 处，
 * 加分也变不出更多室内点。原来那句「雨季，优先安排室内场馆」是过度承诺
 * （实测：晴天室内点占比 16.4% → 雨季 16.8%，16 城里只有 3 城选点变了），
 * 现在改成按「实际排进行程的室内点数量」说话。
 */
function rainDesc(rainy: boolean, indoorTotal: number, indoorPlaced: number): string {
  if (!rainy) return '天气条件适合正常游览'
  if (indoorPlaced > 0) return `雨季 · 本趟已排入 ${indoorPlaced} 个室内点`
  if (indoorTotal > 0) return '雨季 · 室内点没能排进本趟，雨天请备好雨具'
  return '雨季 · 本城暂无室内场馆，雨天请备好雨具'
}

export function WeatherCard({
  cityName,
  info,
  daily,
  loading,
  indoorTotal = 0,
  indoorPlaced = 0,
}: {
  cityName: string
  info: WeatherInfo | null
  daily: DailyWeather[]
  loading: boolean
  /** 这座城市共有多少处室内场馆 —— 数据上限 */
  indoorTotal?: number
  /** 这一趟行程实际排进了几个室内点 —— 实际兑现 */
  indoorPlaced?: number
}) {
  if (!loading && !info) return null

  return (
    <div className="card">
      <div className="card-head">
        <div className="card-icon">🌤</div>
        <div className="card-title">出行天气</div>
        <div className="card-sub">
          {loading
            ? '查询中…'
            : info?.mixed
              ? '预报 + 常年值'
              : info?.isForecast
                ? '未来 16 天预报'
                : '常年值参考'}
        </div>
      </div>

      {loading && !info && (
        <div style={{ fontSize: 13.5, color: 'var(--text-faint)' }}>
          正在向 Open-Meteo 查询{cityName}的天气…
        </div>
      )}

      {info && (
        <>
          <div className="weather-main">
            <div className="weather-icon">{overviewIcon(info)}</div>
            <div className="weather-temp">
              {Math.round(info.high)}°
              <small> / {Math.round(info.low)}°</small>
            </div>
            <div className="weather-desc">
              {rainDesc(info.rainy, indoorTotal, indoorPlaced)}
            </div>
          </div>

          {daily.length > 0 && (
            <div className="weather-strip">
              {daily.map((d) => (
                <div className="weather-day" key={d.date}>
                  <div className="weather-day-date">{shortDate(d.date)}</div>
                  <div className="weather-day-icon">{d.icon}</div>
                  <div className="weather-day-temp">
                    {Math.round(d.high)}° <span>/ {Math.round(d.low)}°</span>
                  </div>
                  <div className="weather-day-label">{d.label}</div>
                  <div className="weather-day-src">{d.source}</div>
                </div>
              ))}
            </div>
          )}

          <div className="weather-grid">
            <div className="weather-cell">
              <div className="weather-k">
                {info.probAvailable ? '降水概率' : '有雨日占比'}
              </div>
              <div className="weather-v">{Math.round(info.rainRatio * 100)}%</div>
            </div>
            <div className="weather-cell">
              <div className="weather-k">日均降水</div>
              <div className="weather-v">{info.precip} mm</div>
            </div>
            <div className="weather-cell">
              <div className="weather-k">样本</div>
              <div className="weather-v">{info.samples} 天</div>
            </div>
          </div>

          <div className="weather-dress">
            <span className="weather-k">穿衣建议</span>
            <span>{info.dressing}</span>
          </div>

          {info.rainy && indoorTotal > 0 && indoorTotal <= 2 && (
            <div className="weather-dress" style={{ color: 'var(--text-faint)' }}>
              <span className="weather-k">雨天弹性</span>
              <span>本城可避雨的室内场馆仅 {indoorTotal} 处，雨天调整空间有限</span>
            </div>
          )}

          <div className="weather-foot">
            {info.summary} · 数据来源 {info.source} · Open-Meteo（免费、无需 Key）
            {daily.some((d) => d.source === '预报') &&
              daily.some((d) => d.source === '常年值') && (
                <>
                  {' '}
                  · 超出 16 天的日子用往年同期实测值补，逐日已标注口径
                </>
              )}
          </div>
        </>
      )}
    </div>
  )
}
