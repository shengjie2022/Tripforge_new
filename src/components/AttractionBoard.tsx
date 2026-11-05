import { useMemo, useState } from 'react'
import { TIME_SLOT_LABELS, type CityPack } from '../data/types'
import { buildBoard, type BoardFilter, type BoardSort } from '../engine/board'
import { minDaysForMustVisit, type TripRequest } from '../engine/itinerary'

interface Props {
  pack: CityPack
  /** 当前的行程条件（估算天数要用它跑真实引擎） */
  request: TripRequest
  /** 已点选的景点 id（顺序 = 点选顺序） */
  selected: string[]
  onToggle: (id: string) => void
  onClear: () => void
  /** 只安排点选的景点 */
  onlySelected: boolean
  onOnlySelected: (v: boolean) => void
}

const SORTS: { v: BoardSort; label: string }[] = [
  { v: 'hot', label: '口碑榜' },
  { v: 'rating', label: '评分' },
  { v: 'signature', label: '必去优先' },
  { v: 'free', label: '免费优先' },
  { v: 'quick', label: '省时优先' },
]

const FILTERS: { v: BoardFilter; label: string }[] = [
  { v: 'all', label: '全部' },
  { v: 'signature', label: '必去' },
  { v: 'free', label: '免费' },
  { v: 'indoor', label: '室内' },
  { v: 'match', label: '合我口味' },
]

export function AttractionBoard(props: Props) {
  const { pack, request, selected, onToggle, onClear, onlySelected, onOnlySelected } = props
  const [sort, setSort] = useState<BoardSort>('hot')
  const [filter, setFilter] = useState<BoardFilter>('all')
  /** 榜单很长，默认展开；收起后只留「已选 N 个」这一条 */
  const [collapsed, setCollapsed] = useState(false)

  const { days, prefs, month } = request

  const entries = useMemo(
    () => buildBoard(pack, { prefs, month, sort, filter }),
    [pack, prefs, month, sort, filter]
  )

  const selectedItems = useMemo(
    () => pack.attractions.filter((a) => selected.includes(a.id)),
    [pack, selected]
  )

  // 这批点至少要几天才排得下。
  // 走真实引擎（minDaysForMustVisit），和行程里的警告用的是同一个函数，
  // 提示与结果不会打架。
  const needDays = useMemo(
    () => minDaysForMustVisit(pack, request, selectedItems.map((a) => a.id)),
    [pack, request, selectedItems]
  )

  // 点选顺序 → 展示用序号
  const orderOf = useMemo(() => {
    const m = new Map<string, number>()
    selected.forEach((id, i) => m.set(id, i + 1))
    return m
  }, [selected])

  const fit = needDays <= days

  return (
    <div className="card">
      <div className="card-head">
        <div className="card-icon">🏆</div>
        <div className="card-title">景点好评榜</div>
        <div className="card-sub">
          {pack.city.name} · {entries.length} 个景点
          <button
            className="board-collapse"
            onClick={() => setCollapsed((c) => !c)}
            aria-expanded={!collapsed}
          >
            {collapsed ? '展开 ▼' : '收起 ▲'}
          </button>
        </div>
      </div>

      {selected.length > 0 && (
        <div className={`board-picked${fit ? '' : ' tight'}`}>
          <div className="board-picked-text">
            已选 <b>{selected.length}</b> 个景点 ·{' '}
            {fit ? (
              <span className="ok">{days} 天排得下</span>
            ) : (
              <span className="bad">
                {days} 天排不下，建议 <b>{needDays}</b> 天
              </span>
            )}
          </div>
          <div className="board-picked-actions">
            <button className="btn btn-ghost board-mini" onClick={onClear}>
              清空
            </button>
            <button
              className={`switch${onlySelected ? ' on' : ''}`}
              onClick={() => onOnlySelected(!onlySelected)}
              aria-label="只安排我选的景点"
              title="打开后，行程里只有你点选的景点"
            />
            <span className="board-switch-label">只安排我选的</span>
          </div>
        </div>
      )}

      {collapsed ? (
        <div className="board-collapsed-hint">
          榜单已收起 · 已选 <b>{selected.length}</b> 个景点
          {selected.length === 0 ? '，点「展开」挑你想要的' : ''}
        </div>
      ) : (
        <>
          <div className="board-bar">
            <div className="segment board-sort">
              {SORTS.map((o) => (
                <button
                  key={o.v}
                  className={sort === o.v ? 'on' : ''}
                  onClick={() => setSort(o.v)}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <div className="tag-cloud board-filters">
              {FILTERS.map((o) => (
                <button
                  key={o.v}
                  className={`tag-chip${filter === o.v ? ' on' : ''}`}
                  onClick={() => setFilter(o.v)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>

      {entries.length === 0 ? (
        <div className="board-empty">这个筛选条件下没有景点，换一个条件试试</div>
      ) : (
        <div className="board-grid">
          {entries.map((e) => {
            const a = e.attraction
            const order = orderOf.get(a.id)
            const on = order !== undefined
            return (
              <button
                key={a.id}
                className={`board-item${on ? ' on' : ''}`}
                onClick={() => onToggle(a.id)}
                aria-pressed={on}
              >
                <div className="board-rank">{e.rank}</div>
                <div className="board-body">
                  <div className="board-name">
                    {a.name}
                    {on && <span className="pill pick">你选的 #{order}</span>}
                  </div>
                  <div className="board-meta">
                    <span className="board-score">★ {a.rating}</span>
                    <span className="board-hot">口碑 {e.hot}</span>
                    <span>{a.ticket > 0 ? `门票 ${a.ticket} 元` : '免费'}</span>
                    <span>{a.hours} 小时</span>
                    <span>{TIME_SLOT_LABELS[a.bestTime]}</span>
                    <span className="board-zone">{a.zone}</span>
                  </div>
                  {e.badges.length > 0 && (
                    <div className="board-badges">
                      {e.badges.map((b) => (
                        <span
                          key={b}
                          className={`pill${b === '必去' ? ' sig' : b === '免费' ? ' ticket' : ''}`}
                        >
                          {b}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="board-desc">{a.desc}</div>
                  {a.tip && <div className="board-tip">💡 {a.tip}</div>}
                </div>
                <div className="board-check">{on ? '✓' : '+'}</div>
              </button>
            )
          })}
        </div>
          )}
        </>
      )}
    </div>
  )
}
