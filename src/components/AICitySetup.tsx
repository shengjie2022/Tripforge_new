import { useEffect, useMemo, useRef, useState } from 'react'
import { buildCityPack, type BuildCityResult } from '../ai/cityBuilder'
import { clearCachedPack, loadCachedPack, saveCachedPack } from '../ai/cache'
import type { AIConfig } from '../ai/client'
import type { CityPack } from '../data/types'
import type { TripRequest } from '../engine/itinerary'
import { AIConfigFields, useAIConfig } from './AIConfigFields'

interface Props {
  cityName: string
  request: TripRequest
  /** 已经生成好的包（重新生成时会传回来） */
  current?: CityPack | null
  onGenerated: (pack: CityPack) => void
}

/**
 * 自定义城市（内置 16 城之外）的生成引导面板
 *
 * 流程：读缓存 → 没有就配置 Key → 模型生成城市素材 → 交给本地规则引擎编排行程
 */
export function AICitySetup({ cityName, request, current, onGenerated }: Props) {
  const { cfg, loaded, save, clear } = useAIConfig()
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [result, setResult] = useState<BuildCityResult | null>(null)

  // 缓存按城市名取一次即可，避免每次渲染都是新对象导致 effect 反复触发
  const cached = useMemo(() => loadCachedPack(cityName), [cityName])
  const appliedRef = useRef(false)
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])

  // 有缓存就直接用上，不用等用户点
  useEffect(() => {
    if (appliedRef.current) return
    if (cached && !current) {
      appliedRef.current = true
      onGenerated(cached)
    }
  }, [cached, current, onGenerated])

  const run = async (activeCfg: AIConfig, force: boolean) => {
    controller.current?.abort()
    const active = new AbortController()
    controller.current = active
    if (force) clearCachedPack(cityName)
    setBusy(true)
    setErr('')
    try {
      const res = await buildCityPack(activeCfg, {
        cityName,
        days: request.days,
        month: request.month,
        budget: request.budget,
        travelers: request.travelers,
        style: request.style,
        pace: request.pace,
        prefs: request.prefs,
      }, active.signal)
      if (active.signal.aborted) return
      setResult(res)
      saveCachedPack(cityName, res.pack)
      onGenerated(res.pack)
    } catch (e) {
      if (!active.signal.aborted) setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // 还没配 Key，先引导配置
  if (!loaded) {
    return <div className="card">加载中…</div>
  }

  if (!cfg || editing) {
    return (
      <div className="card">
        <div className="card-head">
          <div className="card-icon">🛰️</div>
          <div className="card-title">用大模型生成「{cityName}」</div>
          <div className="card-sub">{cfg ? '修改配置' : '需要配置 API Key'}</div>
        </div>

        <div
          style={{
            fontSize: 13.5,
            color: 'var(--text-dim)',
            lineHeight: 1.8,
            marginBottom: 16,
          }}
        >
          内置 16 城之外的目的地，需要先让大模型查一份城市资料
          （景点、门票、住宿、餐饮、交通），再交给<b>本地规则引擎</b>编排逐日行程 ——
          所以时间轴、同日距离、预算这些硬约束依然由本地引擎把关，不会被模型带偏。
          <br />
          <br />
          API Key 只保存在你本机浏览器，请求由浏览器直连你自己填的接口，不经过任何中间服务器。
        </div>

        <AIConfigFields
          initial={cfg}
          saveLabel="保存并生成"
          onSave={(next) => {
            save(next)
            setEditing(false)
            void run(next, false)
          }}
          onCancel={() => setEditing(false)}
        />
      </div>
    )
  }

  const preview = result?.pack ?? current ?? cached ?? null

  return (
    <div className="card">
      <div className="card-head">
        <div className="card-icon">🛰️</div>
        <div className="card-title">「{cityName}」城市资料</div>
        <div className="card-sub">
          {busy ? '生成中…' : preview ? '已生成' : '待生成'}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap', marginBottom: 14 }}>
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void run(cfg, false)}
        >
          {busy ? '生成中…' : preview ? '重新生成' : '生成城市资料'}
        </button>
        {preview && (
          <button
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => void run(cfg, true)}
          >
            清缓存重生成
          </button>
        )}
        <button className="btn btn-ghost" onClick={() => setEditing(true)}>
          修改 API 配置
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => {
            controller.current?.abort()
            setBusy(false)
            clear()
            setEditing(false)
          }}
        >
          移除配置
        </button>
      </div>

      {busy && (
        <div
          style={{
            fontSize: 13,
            color: 'var(--text-dim)',
            padding: '12px 14px',
            background: 'var(--bg-soft)',
            borderRadius: 'var(--radius-sm)',
            lineHeight: 1.8,
          }}
        >
          正在让模型整理「{cityName}」的景点、住宿、餐饮与交通资料，
          完成后本地引擎会立刻编排出逐日行程。首次生成通常需要 1-3 分钟。
        </div>
      )}

      {err && (
        <div className="tip-item warn-item" style={{ marginTop: 12 }}>
          <span>⚠</span>
          <span>
            {err}
            <br />
            <span style={{ color: 'var(--text-faint)' }}>
              常见原因：接口地址填错（要填到 /v1）、协议选错、Key 无效、模型名不支持。
            </span>
          </span>
        </div>
      )}

      {preview && !busy && (
        <div className="city-pack-preview">
          <div className="cpp-stats">
            <span>{preview.attractions.length} 个景点</span>
            <span>{preview.hotels.length} 家住宿</span>
            <span>{preview.foods.length} 种必吃</span>
            <span>{preview.transit.length} 种交通</span>
            {cached && !result && <span>来自本地缓存</span>}
          </div>

          {result?.issues.notes.length ? (
            <div className="tip-item warn-item" style={{ marginTop: 12 }}>
              <span>⚠</span>
              <span>{result.issues.notes.join('；')}</span>
            </div>
          ) : null}

          <div className="cpp-list">
            {preview.attractions.slice(0, 10).map((a) => (
              <span className="pill" key={a.id}>
                {a.name}
              </span>
            ))}
            {preview.attractions.length > 10 && (
              <span className="pill" style={{ opacity: 0.6 }}>
                +{preview.attractions.length - 10}
              </span>
            )}
          </div>

          <div
            style={{
              marginTop: 12,
              fontSize: 12.5,
              color: 'var(--text-faint)',
              lineHeight: 1.8,
            }}
          >
            资料由大模型生成，仅供参考。门票、开放时间以官方公告为准；行程编排由本地引擎完成。
          </div>
        </div>
      )}
    </div>
  )
}
