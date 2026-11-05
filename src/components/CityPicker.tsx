import { useEffect, useMemo, useRef, useState } from 'react'
import { CITY_OPTIONS, searchCities, type CityOption } from '../data'
import { saveCustomOrigin, searchOrigins } from '../data/origins'
import { geocodeCity, type GeoHit } from '../api/geocode'

/** 自定义城市在 cityId 里的前缀，形如 `ai:洛阳` */
export const AI_CITY_PREFIX = 'ai:'

export function parseAICityId(id: string): string | null {
  return id.startsWith(AI_CITY_PREFIX) ? id.slice(AI_CITY_PREFIX.length) : null
}

interface Props {
  value: string
  onChange: (id: string) => void
}

export function CityPicker({ value, onChange }: Props) {
  const [keyword, setKeyword] = useState('')
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  const aiCityName = parseAICityId(value)
  const selected = useMemo<CityOption | null>(() => {
    if (aiCityName) {
      return {
        id: value,
        name: aiCityName,
        enName: 'AI 生成',
        country: '中国',
        tagline: '由大模型生成资料',
        tags: [],
        overseas: false,
        bestMonths: [],
      }
    }
    return CITY_OPTIONS.find((c) => c.id === value) ?? null
  }, [value, aiCityName])

  const results = useMemo(() => searchCities(keyword), [keyword])

  // 关键词没命中内置城市时，给出「用 AI 生成」的入口
  const customName = keyword.trim()
  const canGenerate =
    customName.length > 0 &&
    !CITY_OPTIONS.some((c) => c.name === customName || c.enName.toLowerCase() === customName.toLowerCase())

  // 点击外部关闭下拉
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const pick = (c: CityOption) => {
    onChange(c.id)
    setOpen(false)
    setKeyword('')
  }

  const pickCustom = () => {
    onChange(AI_CITY_PREFIX + customName)
    setOpen(false)
    setKeyword('')
  }

  return (
    <div className="form-group" ref={boxRef}>
      <div className="label">目的地城市</div>
      <div className="city-search">
        {selected && !open ? (
          <button className="input" style={{ textAlign: 'left' }} onClick={() => setOpen(true)}>
            <span style={{ fontWeight: 600 }}>{selected.name}</span>
            <span style={{ color: 'var(--text-faint)', fontSize: 13, marginLeft: 8 }}>
              {selected.enName}
            </span>
          </button>
        ) : (
          <input
            className="input"
            autoFocus
            placeholder="输入城市名，如 成都 / 京都，或任意城市名"
            value={keyword}
            onChange={(e) => {
              setKeyword(e.target.value)
              setOpen(true)
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canGenerate) {
                e.preventDefault()
                pickCustom()
              }
            }}
          />
        )}

        {open && (
          <div className="city-dropdown">
            {results.length === 0 && !canGenerate && (
              <div className="city-option" style={{ color: 'var(--text-faint)' }}>
                没有匹配的城市
              </div>
            )}
            {results.map((c) => (
              <button
                key={c.id}
                className={`city-option${c.id === value ? ' sel' : ''}`}
                onClick={() => pick(c)}
              >
                <span className="city-opt-name">{c.name}</span>
                <span className="city-opt-meta">{c.enName}</span>
                {c.overseas && <span className="badge">境外</span>}
              </button>
            ))}

            {canGenerate && (
              <button className="city-option ai-option" onClick={pickCustom}>
                <span className="city-opt-name">🛰️ 用 AI 生成「{customName}」的攻略</span>
                <span className="city-opt-meta">任意城市</span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

interface OriginProps {
  value: string
  onChange: (v: string) => void
}

/**
 * 出发地选择器
 *
 * 内置 380+ 个城市（人工维护的常用 49 个 + 自动生成的地级行政区 334 个），
 * 搜不到时还能输入任意地名（县级市、区县），由 Photon 解析坐标。
 */
export function OriginPicker({ value, onChange }: OriginProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState(false)
  const [remote, setRemote] = useState<GeoHit | null>(null)
  const [busy, setBusy] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const reqId = useRef(0)

  const kw = query.trim()

  const localHits = useMemo(() => {
    const hits = searchOrigins(kw, 40)
    if (kw) return hits
    // 没输入关键词：把当前选中的城市顶到最前，方便确认
    const i = hits.findIndex((o) => o.name === value)
    if (i > 0) {
      const [sel] = hits.splice(i, 1)
      return [sel, ...hits]
    }
    return hits
  }, [kw, value])

  // 本地已经能命中时就不去打扰 Photon —— 收录表的坐标更准，还省一次请求
  const hasLocal = localHits.length > 0

  // 点击外部收起，恢复成「按钮」形态
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false)
        setEditing(false)
        setQuery('')
        setRemote(null)
        setBusy(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  // 输入停顿 600ms 后再去解析，避免每敲一个字都发请求
  useEffect(() => {
    if (kw.length < 2 || hasLocal) {
      reqId.current++ // 作废在途请求
      return
    }
    const timer = setTimeout(() => {
      const id = ++reqId.current
      setBusy(true)
      void geocodeCity(kw)
        .then((hit) => {
          if (id !== reqId.current) return
          setRemote(hit)
        })
        .finally(() => {
          if (id === reqId.current) setBusy(false)
        })
    }, 600)
    return () => clearTimeout(timer)
  }, [kw, hasLocal])

  const pick = (name: string, coords?: [number, number]) => {
    if (coords) {
      // 解析出来的城市存进本地，下次直接命中，也方便分享链接时复用
      saveCustomOrigin({ id: `custom-${name}`, name, coordinates: coords })
    }
    onChange(name)
    setOpen(false)
    setEditing(false)
    setQuery('')
    setRemote(null)
    setBusy(false)
  }

  // 本地没命中、且在线解析出了结果时才展示，避免和本地项重复
  const showRemote = !hasLocal && remote !== null

  return (
    <div className="form-group" ref={boxRef}>
      <div className="label">出发地</div>
      <div className="city-search">
        {editing ? (
          <input
            className="input"
            autoFocus
            value={query}
            placeholder="输入出发城市，如 上海 / 温州 / 昆山"
            onChange={(e) => {
              setQuery(e.target.value)
              setRemote(null)
              setBusy(false)
              setOpen(true)
            }}
          />
        ) : (
          <button
            className="input"
            style={{ textAlign: 'left' }}
            onClick={() => {
              setEditing(true)
              setQuery('')
              setOpen(true)
            }}
          >
            <span style={{ fontWeight: 600 }}>{value || '未指定'}</span>
            <span style={{ color: 'var(--text-faint)', fontSize: 13, marginLeft: 8 }}>
              选择出发地
            </span>
          </button>
        )}

        {open && (
          <div className="city-dropdown">
            {!value && (
              <button className="city-option" onClick={() => pick('')}>
                <span className="city-opt-name">未指定</span>
                <span className="city-opt-meta">仅按目的地估算</span>
              </button>
            )}

            {localHits.map((o) => (
              <button
                key={o.id}
                className={`city-option${o.name === value ? ' sel' : ''}`}
                onClick={() => pick(o.name)}
              >
                <span className="city-opt-name">{o.name}</span>
                <span className="city-opt-meta">
                  {o.name === value ? '当前选择' : '已收录'}
                </span>
              </button>
            ))}

            {showRemote && (
              <button
                className="city-option ai-option"
                onClick={() => pick(remote!.name, remote!.coordinates)}
              >
                <span className="city-opt-name">📍 {remote!.name}</span>
                <span className="city-opt-meta">
                  {remote!.region ?? '在线解析'} · 非收录城市
                </span>
              </button>
            )}

            {busy && (
              <div className="city-option" style={{ color: 'var(--text-faint)' }}>
                正在解析…
              </div>
            )}

            {!busy && kw.length >= 2 && !hasLocal && !showRemote && (
              <div className="city-option" style={{ color: 'var(--text-faint)' }}>
                没找到「{kw}」，换个写法试试（可带「市」字）
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
