import { useMemo, useState } from 'react'
import type { CityPack } from '../data/types'
import type { TripPlan } from '../engine/itinerary'

/**
 * 行程路线图
 *
 * 用的是城市内部的公里网格坐标（原点 = 核心商圈，x 正东 / y 正北，单位 km）。
 * 这套坐标在手工维护的 16 城里是按真实方位布的，在 AI 城市里是由
 * 「方位 + 距离」换算出来的 —— 所以画出来的图**大致符合真实地理关系**，
 * 但它不是按经纬度投影的底图，界面上会注明「示意路线图」。
 *
 * 两个容易做砸的地方，这里都处理了：
 *
 *   1) **视口要贴合内容**。固定画布尺寸的话，只要行程里有一个远郊点
 *      （比如成都的都江堰在 34km 外），整张图就会空掉一大半。
 *      所以 viewBox 直接按内容的实际宽高算，让图填满卡片。
 *   2) **标签要避让**。同一片区的几个点挨得很近，标签一压就全糊成一团。
 *      这里给每个标签按「右 → 左 → 下 → 上」试位，避开已放置的标签框
 *      和标记圆，实在放不下就只留编号（悬停有 tooltip）。
 */

const VIEW_W = 1000
const VIEW_H = 560
/** 视图留白（像素） */
const PAD = 56
/** 标签字号（viewBox 单位） */
const LABEL_SIZE = 12.5

/** 每天一条线的配色 */
const DAY_COLORS = [
  '#4ade80',
  '#38bdf8',
  '#a78bfa',
  '#fbbf24',
  '#f472b6',
  '#2dd4bf',
  '#fb923c',
  '#e879f9',
]

interface Point {
  x: number
  y: number
}

/** 一个矩形（用于标签避让） */
interface Box {
  x: number
  y: number
  w: number
  h: number
}

function overlaps(a: Box, b: Box): boolean {
  return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y)
}

/** 估算文字宽度：中文按 1em，其余按 0.56em */
function textWidth(text: string, size: number): number {
  let w = 0
  for (const ch of text) w += ch.charCodeAt(0) > 255 ? size : size * 0.56
  return w
}

export function TripMap({ plan, pack }: { plan: TripPlan; pack: CityPack }) {
  /** null = 看全程；数字 = 只看那一天 */
  const [focus, setFocus] = useState<number | null>(null)

  const hotel = plan.lodging.hotel

  // 有内容的那些天
  const days = useMemo(() => plan.days.filter((d) => d.items.length > 0), [plan.days])

  // 切换城市 / 天数后，focus 可能指向一个已经没有内容的日子。
  // 不做这层兜底的话，整张图会淡掉、而且没有任何按钮处于高亮态。
  const activeDay =
    focus !== null && days.some((d) => d.day === focus) ? focus : null

  const geo = useMemo(() => {
    const points: Point[] = []
    for (const d of days) {
      for (const it of d.items) points.push(it.attraction)
    }
    if (hotel?.name) points.push(hotel)

    if (!points.length) return null

    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const p of points) {
      if (p.x < minX) minX = p.x
      if (p.x > maxX) maxX = p.x
      if (p.y < minY) minY = p.y
      if (p.y > maxY) maxY = p.y
    }
    const spanX = Math.max(0.8, maxX - minX)
    const spanY = Math.max(0.8, maxY - minY)

    // 统一比例尺（不变形），取能装进画布的最小比例
    const pxPerKm = Math.min((VIEW_W - PAD * 2) / spanX, (VIEW_H - PAD * 2) / spanY)
    const W = VIEW_W
    const H = VIEW_H
    // 内容在画布里居中
    const contentW = spanX * pxPerKm
    const contentH = spanY * pxPerKm
    const offsetX = (W - contentW) / 2
    const offsetY = (H - contentH) / 2

    return {
      minX,
      minY,
      pxPerKm,
      W,
      H,
      project: (p: Point) => ({
        x: (p.x - minX) * pxPerKm + offsetX,
        // 网格 y 正北 = SVG y 向上，所以取反
        y: offsetY + contentH - (p.y - minY) * pxPerKm,
      }),
    }
  }, [days, hotel])

  /* ---------------- 标签避让 ---------------- */
  const labelBoxes = useMemo(() => {
    const boxes: Box[] = []
    if (!geo) return { boxes, labels: [] }
    const project = geo.project
    // 标记圆先占位，标签不能压在标记上
    for (const d of days) {
      for (const it of d.items) {
        const p = project(it.attraction)
        boxes.push({ x: p.x - 13, y: p.y - 13, w: 26, h: 26 })
      }
    }
    if (hotel?.name) {
      const p = project(hotel)
      boxes.push({ x: p.x - 12, y: p.y - 12, w: 24, h: 24 })
    }

    type Label = {
      key: string
      text: string
      color: string
      x: number
      y: number
      anchor: 'start' | 'end' | 'middle'
      day: number
    }
    const labels: Label[] = []

    const tryPlace = (
      key: string,
      text: string,
      color: string,
      px: number,
      py: number,
      day: number
    ): void => {
      const w = textWidth(text, LABEL_SIZE)
      const h = LABEL_SIZE + 4
      // 候选位：右、左、下、上、右下、左下
      const candidates: { dx: number; dy: number; anchor: 'start' | 'end' | 'middle' }[] = [
        { dx: 17, dy: 4, anchor: 'start' },
        { dx: -17, dy: 4, anchor: 'end' },
        { dx: 0, dy: 20, anchor: 'middle' },
        { dx: 0, dy: -16, anchor: 'middle' },
        { dx: 15, dy: 20, anchor: 'start' },
        { dx: -15, dy: 20, anchor: 'end' },
      ]
      for (const c of candidates) {
        const cx = px + c.dx
        const cy = py + c.dy
        const left = c.anchor === 'start' ? cx : c.anchor === 'end' ? cx - w : cx - w / 2
        const box: Box = { x: left - 2, y: cy - h, w: w + 4, h }
        if (boxes.some((b) => overlaps(box, b))) continue
        boxes.push(box)
        labels.push({ key, text, color, x: cx, y: cy, anchor: c.anchor, day })
        return
      }
      // 实在放不下就不画标签（编号和 tooltip 还在）
    }

    for (const d of days) {
      d.items.forEach((it) => {
        const p = project(it.attraction)
        tryPlace(
          `a-${d.day}-${it.attraction.id}`,
          it.attraction.name,
          DAY_COLORS[(d.day - 1) % DAY_COLORS.length],
          p.x,
          p.y,
          d.day
        )
      })
    }
    if (hotel?.name) {
      const p = project(hotel)
      tryPlace('hotel', `住宿 ${hotel.zone}`, 'var(--accent)', p.x, p.y, 0)
    }

    return { boxes, labels }
  }, [days, hotel, geo])

  // 早退必须放在所有 hook 之后 —— 否则天数从 0 变成非 0 时 hook 数量会变，
  // React 会直接报「Rendered fewer hooks than expected」
  if (!days.length || !geo) return null

  const { project, pxPerKm, W, H } = geo

  // 比例尺长度（viewBox 单位）
  const scaleBar = (() => {
    const targets = [0.2, 0.5, 1, 2, 5, 10, 20, 50]
    let km = targets[0]
    for (const t of targets) {
      if (t * pxPerKm <= 130) km = t
    }
    return { km, px: km * pxPerKm }
  })()

  const dimmed = activeDay !== null
  const labelOpacity = (day: number): number =>
    dimmed && activeDay !== day ? 0.18 : 1

  return (
    <div className="card">
      <div className="card-head">
        <div className="card-icon">🗺️</div>
        <div className="card-title">路线图</div>
        <div className="card-sub">示意路线图 · 非地理底图</div>
      </div>

      <div className="map-chips">
        <button
          className={`map-chip${activeDay === null ? ' on' : ''}`}
          onClick={() => setFocus(null)}
        >
          全程 {days.length} 天
        </button>
        {days.map((d) => (
          <button
            key={d.day}
            className={`map-chip${activeDay === d.day ? ' on' : ''}`}
            onClick={() => setFocus(activeDay === d.day ? null : d.day)}
          >
            <span
              className="map-chip-dot"
              style={{ background: DAY_COLORS[(d.day - 1) % DAY_COLORS.length] }}
            />
            第 {d.day} 天
          </button>
        ))}
      </div>

      <svg
        className="map-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="逐日路线示意图"
      >
        <defs>
          <pattern
            id="map-grid"
            width="40"
            height="40"
            patternUnits="userSpaceOnUse"
          >
            <path
              d="M 40 0 L 0 0 0 40"
              fill="none"
              stroke="rgba(255,255,255,0.05)"
              strokeWidth="1"
            />
          </pattern>
        </defs>
        <rect width={W} height={H} fill="url(#map-grid)" />

        {/* 每天一条折线 */}
        {days.map((d) => {
          const color = DAY_COLORS[(d.day - 1) % DAY_COLORS.length]
          const pts = d.items.map((it) => project(it.attraction))
          const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
          const off = dimmed && activeDay !== d.day
          return (
            <path
              key={`line-${d.day}`}
              d={path}
              fill="none"
              stroke={color}
              strokeWidth={off ? 2 : 3}
              strokeOpacity={off ? 0.3 : 0.85}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={off ? '4 7' : undefined}
            />
          )
        })}

        {/* 住宿标记 */}
        {hotel?.name && (
          <g
            opacity={dimmed ? 0.3 : 1}
            transform={`translate(${project(hotel).x}, ${project(hotel).y})`}
          >
            <rect
              x="-7"
              y="-7"
              width="14"
              height="14"
              rx="3"
              transform="rotate(45)"
              fill="#212a36"
              stroke="var(--accent)"
              strokeWidth="2"
            />
          </g>
        )}

        {/* 景点标记 */}
        {days.map((d) => {
          const color = DAY_COLORS[(d.day - 1) % DAY_COLORS.length]
          const off = dimmed && activeDay !== d.day
          return (
            <g key={`pts-${d.day}`} opacity={off ? 0.18 : 1}>
              {d.items.map((it, i) => {
                const p = project(it.attraction)
                return (
                  <g key={it.attraction.id} transform={`translate(${p.x}, ${p.y})`}>
                    <circle
                      r="11"
                      fill={color}
                      fillOpacity="0.22"
                      stroke={color}
                      strokeWidth="2"
                    />
                    <text y="4" textAnchor="middle" className="map-num" fill={color}>
                      {i + 1}
                    </text>
                    <title>{`第 ${d.day} 天 第 ${i + 1} 站 · ${it.attraction.name}（${it.attraction.zone}）`}</title>
                  </g>
                )
              })}
            </g>
          )
        })}

        {/* 标签（带避让） */}
        {labelBoxes.labels.map((l) => (
          <text
            key={l.key}
            x={l.x}
            y={l.y}
            className="map-label"
            fill={l.color}
            textAnchor={l.anchor}
            opacity={labelOpacity(l.day)}
          >
            {l.text}
          </text>
        ))}

        {/* 比例尺 */}
        <g transform={`translate(${PAD * 0.55}, ${H - 26})`}>
          <line
            x1="0"
            y1="0"
            x2={scaleBar.px}
            y2="0"
            stroke="var(--text-faint)"
            strokeWidth="2"
          />
          <line x1="0" y1="-4" x2="0" y2="4" stroke="var(--text-faint)" strokeWidth="2" />
          <line
            x1={scaleBar.px}
            y1="-4"
            x2={scaleBar.px}
            y2="4"
            stroke="var(--text-faint)"
            strokeWidth="2"
          />
          <text x={scaleBar.px / 2} y="-9" className="map-scale" textAnchor="middle">
            {scaleBar.km} km
          </text>
        </g>
      </svg>

      <div className="map-foot">
        {pack.city.name} · 内部公里网格示意（原点为核心商圈，x 正东 / y 正北）。
        折线只表示当天先后顺序与大致方位，不代表真实路网。
      </div>
    </div>
  )
}
