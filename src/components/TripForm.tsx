import { TAG_LABELS, type BudgetStyle, type Pace, type Tag } from '../data/types'
import { formatCN, weekdayCN } from '../utils/date'

interface Props {
  days: number
  onDays: (v: number) => void
  budget: number
  onBudget: (v: number) => void
  travelers: number
  onTravelers: (v: number) => void
  style: BudgetStyle
  onStyle: (v: BudgetStyle) => void
  pace: Pace
  onPace: (v: Pace) => void
  month: number
  onMonth: (v: number) => void
  prefs: Tag[]
  onPrefs: (v: Tag[]) => void
  includeTransport: boolean
  onIncludeTransport: (v: boolean) => void
  startDate: string
  onStartDate: (v: string) => void
}

const STYLE_OPTS: { v: BudgetStyle; label: string }[] = [
  { v: 'thrifty', label: '穷游省钱' },
  { v: 'balanced', label: '舒适均衡' },
  { v: 'premium', label: '品质精选' },
]

const PACE_OPTS: { v: Pace; label: string }[] = [
  { v: 'packed', label: '紧凑暴走' },
  { v: 'balanced', label: '张弛有度' },
  { v: 'relaxed', label: '悠闲慢游' },
]

const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1)

const PREF_OPTS: Tag[] = [
  'food',
  'history',
  'nature',
  'photo',
  'shopping',
  'night',
  'family',
  'local',
  'art',
  'relax',
  'water',
  'mountain',
  'indoor',
]

export function TripForm(props: Props) {
  const {
    days,
    onDays,
    budget,
    onBudget,
    travelers,
    onTravelers,
    style,
    onStyle,
    pace,
    onPace,
    month,
    onMonth,
    prefs,
    onPrefs,
    includeTransport,
    onIncludeTransport,
    startDate,
    onStartDate,
  } = props

  const togglePref = (t: Tag) => {
    onPrefs(prefs.includes(t) ? prefs.filter((p) => p !== t) : [...prefs, t])
  }

  return (
    <>
      <div className="form-group">
        <div className="label">
          行程天数 <span className="val">{days} 天</span>
        </div>
        <input
          type="range"
          min={1}
          max={15}
          value={days}
          onChange={(e) => onDays(Number(e.target.value))}
        />
      </div>

      <div className="form-group">
        <div className="label">
          总预算 <span className="val">{budget.toLocaleString()} 元</span>
        </div>
        <input
          type="range"
          min={1000}
          max={80000}
          step={500}
          value={budget}
          onChange={(e) => onBudget(Number(e.target.value))}
        />
      </div>

      <div className="form-group">
        <div className="label">
          同行人数 <span className="val">{travelers} 人</span>
        </div>
        <input
          type="range"
          min={1}
          max={10}
          value={travelers}
          onChange={(e) => onTravelers(Number(e.target.value))}
        />
      </div>

      <div className="form-group">
        <div className="label">消费风格</div>
        <div className="segment">
          {STYLE_OPTS.map((o) => (
            <button
              key={o.v}
              className={style === o.v ? 'on' : ''}
              onClick={() => onStyle(o.v)}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      <div className="form-group">
        <div
          className="label"
          title="每天最多安排：紧凑暴走 5 个点 / 11 小时游玩，张弛有度 3 个点 / 8.5 小时，悠闲慢游 2 个点 / 6 小时（游玩时长不含路上与用餐时间，所以行程卡片上的「共 X h」会略大于它）"
        >
          行程节奏
        </div>
        <div className="segment">
          {PACE_OPTS.map((o) => (
            <button
              key={o.v}
              className={pace === o.v ? 'on' : ''}
              onClick={() => onPace(o.v)}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      <div className="form-group">
        <div className="label">出行月份</div>
        <select
          className="select"
          value={month}
          onChange={(e) => onMonth(Number(e.target.value))}
        >
          {MONTHS.map((m) => (
            <option key={m} value={m}>
              {m} 月
            </option>
          ))}
        </select>
      </div>

      <div className="form-group">
        <div className="label">
          出发日期{' '}
          <span className="val">
            {startDate ? `${formatCN(startDate)}（${weekdayCN(startDate)}）` : '未设置'}
          </span>
        </div>
        <input
          className="input"
          type="date"
          value={startDate}
          onChange={(e) => onStartDate(e.target.value)}
        />
      </div>

      <div className="form-group">
        <div className="label">
          兴趣偏好 <span className="val">{prefs.length ? `${prefs.length} 项` : '不选=均衡'}</span>
        </div>
        <div className="tag-cloud">
          {PREF_OPTS.map((t) => (
            <button
              key={t}
              className={`tag-chip${prefs.includes(t) ? ' on' : ''}`}
              onClick={() => togglePref(t)}
            >
              {TAG_LABELS[t]}
            </button>
          ))}
        </div>
      </div>

      <div className="form-group">
        <div className="switch-row">
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>预算含往返大交通</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
              关闭则预算只覆盖当地吃住行
            </div>
          </div>
          <button
            className={`switch${includeTransport ? ' on' : ''}`}
            onClick={() => onIncludeTransport(!includeTransport)}
            aria-label="切换是否包含往返大交通"
          />
        </div>
      </div>
    </>
  )
}
