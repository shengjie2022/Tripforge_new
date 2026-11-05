import { useEffect, useRef, useState } from 'react'
import { generateTravelNote } from '../ai/client'
import type { CityPack } from '../data/types'
import { BUDGET_STYLE_LABELS, PACE_LABELS, TAG_LABELS } from '../data/types'
import type { TripPlan } from '../engine/itinerary'
import { AIConfigFields, useAIConfig } from './AIConfigFields'

interface Props {
  plan: TripPlan
  pack: CityPack
}

export function AIEnhance({ plan, pack }: Props) {
  const { cfg, loaded, save, clear } = useAIConfig()
  const [editing, setEditing] = useState(false)
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])

  const run = async () => {
    if (!cfg) return
    controller.current?.abort()
    const active = new AbortController()
    controller.current = active
    setLoading(true)
    setErr('')
    setNote('')
    try {
      const route = plan.days
        .map(
          (d) =>
            `第${d.day}天（${d.title}）：${d.items
              .map((i) => i.attraction.name)
              .join(' → ')}`
        )
        .join('\n')
      const text = await generateTravelNote(cfg, {
        city: pack.city.name,
        days: plan.request.days,
        month: plan.request.month,
        budget: plan.request.budget,
        travelers: plan.request.travelers,
        pace: PACE_LABELS[plan.request.pace],
        style: BUDGET_STYLE_LABELS[plan.request.style],
        prefs: plan.request.prefs.map((p) => TAG_LABELS[p]),
        highlights: pack.city.highlights,
        route,
        warnings: plan.warnings,
      }, active.signal)
      if (!active.signal.aborted) setNote(text)
    } catch (e) {
      if (!active.signal.aborted) setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  if (!loaded) return null

  return (
    <div className="card">
      <div className="card-head">
        <div className="card-icon">✨</div>
        <div className="card-title">AI 增强（可选）</div>
        <div className="card-sub">
          {cfg ? `已配置 ${cfg.model}` : '未配置 · 纯本地引擎已可用'}
        </div>
      </div>

      {!cfg && !editing && (
        <>
          <div style={{ fontSize: 13.5, color: 'var(--text-dim)', lineHeight: 1.75 }}>
            上面的路线、预算、住宿全部由本地规则引擎算出，<b>不需要任何 Key</b>。
            如果你想要一段更贴合你行程的出行提示，可以填入你自己的大模型
            API Key —— Key 只存在你本机浏览器，直接请求你自己的接口，不经过任何中间服务器。
          </div>
          <button
            className="btn"
            style={{ marginTop: 12 }}
            onClick={() => setEditing(true)}
          >
            配置 API Key
          </button>
        </>
      )}

      {editing && (
        <AIConfigFields
          initial={cfg}
          onSave={(next) => {
            save(next)
            setEditing(false)
          }}
          onCancel={() => setEditing(false)}
        />
      )}

      {cfg && !editing && (
        <>
          <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={run} disabled={loading}>
              {loading ? '生成中…' : '生成出行提示'}
            </button>
            <button className="btn btn-ghost" onClick={() => setEditing(true)}>
              修改配置
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => {
                controller.current?.abort()
                setLoading(false)
                clear()
                setNote('')
              }}
            >
              移除配置
            </button>
          </div>

          {err && (
            <div className="tip-item warn-item" style={{ marginTop: 12 }}>
              <span>⚠</span>
              <span>{err}</span>
            </div>
          )}

          {note && (
            <div
              style={{
                marginTop: 14,
                padding: '15px 17px',
                background: 'var(--bg-soft)',
                borderRadius: 'var(--radius-sm)',
                borderLeft: '2.5px solid var(--accent)',
                fontSize: 14,
                lineHeight: 1.85,
                color: 'var(--text-dim)',
                whiteSpace: 'pre-wrap',
              }}
            >
              {note}
            </div>
          )}
        </>
      )}
    </div>
  )
}
