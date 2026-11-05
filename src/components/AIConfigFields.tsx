import { useEffect, useState } from 'react'
import {
  clearAIConfig,
  loadAIConfig,
  saveAIConfig,
  AI_PROTOCOL_LABELS,
  type AIConfig,
  type AIProtocol,
} from '../ai/client'

/**
 * AI 配置的统一状态管理
 * 键只存在本机 localStorage，不上传任何第三方服务器。
 */
export function useAIConfig() {
  const [cfg, setCfg] = useState<AIConfig | null>(loadAIConfig)
  const loaded = true

  useEffect(() => {
    const sync = () => setCfg(loadAIConfig())
    window.addEventListener('tripforge-ai-config', sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener('tripforge-ai-config', sync)
      window.removeEventListener('storage', sync)
    }
  }, [])

  const save = (next: AIConfig) => {
    saveAIConfig(next)
    setCfg(next)
    window.dispatchEvent(new Event('tripforge-ai-config'))
  }

  const clear = () => {
    clearAIConfig()
    setCfg(null)
    window.dispatchEvent(new Event('tripforge-ai-config'))
  }

  return { cfg, loaded, save, clear }
}

interface FieldsProps {
  /** 已有配置（用于回填） */
  initial?: AIConfig | null
  onSave: (cfg: AIConfig) => void
  onCancel?: () => void
  saveLabel?: string
  /** 额外的说明文字 */
  hint?: string
}

/** API 配置表单（增强提示与城市生成共用） */
export function AIConfigFields({
  initial,
  onSave,
  onCancel,
  saveLabel = '保存配置',
  hint,
}: FieldsProps) {
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? 'https://api.openai.com/v1')
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? '')
  const [model, setModel] = useState(initial?.model ?? 'gpt-4o-mini')
  const [protocol, setProtocol] = useState<AIProtocol>(initial?.protocol ?? 'openai')

  return (
    <div className="form-group" style={{ marginBottom: 0 }}>
      {hint && (
        <div
          style={{
            fontSize: 13,
            color: 'var(--text-dim)',
            lineHeight: 1.75,
            marginBottom: 14,
          }}
        >
          {hint}
        </div>
      )}

      <div className="label">接口协议</div>
      <div className="segment" style={{ marginBottom: 14 }}>
        {(Object.keys(AI_PROTOCOL_LABELS) as AIProtocol[]).map((p) => (
          <button
            key={p}
            type="button"
            className={protocol === p ? 'on' : ''}
            onClick={() => {
              setProtocol(p)
              // 换协议时给个更可能的默认地址与模型
              if (p === 'anthropic') {
                if (baseUrl.includes('openai.com')) setBaseUrl('https://api.anthropic.com/v1')
                if (model === 'gpt-4o-mini') setModel('claude-sonnet-4-20250514')
              } else {
                if (baseUrl.includes('anthropic.com')) setBaseUrl('https://api.openai.com/v1')
                if (model.startsWith('claude')) setModel('gpt-4o-mini')
              }
            }}
          >
            {AI_PROTOCOL_LABELS[p]}
          </button>
        ))}
      </div>

      <div className="label">接口地址 Base URL</div>
      <input
        className="input"
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
        placeholder={
          protocol === 'anthropic'
            ? 'https://api.anthropic.com/v1'
            : 'https://api.openai.com/v1'
        }
      />

      <div className="label" style={{ marginTop: 12 }}>API Key</div>
      <input
        className="input"
        type="password"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        placeholder="sk-..."
      />

      <div className="label" style={{ marginTop: 12 }}>模型</div>
      <input
        className="input"
        value={model}
        onChange={(e) => setModel(e.target.value)}
        placeholder={protocol === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4o-mini'}
      />

      <div style={{ display: 'flex', gap: 9, marginTop: 14, flexWrap: 'wrap' }}>
        <button
          className="btn btn-primary"
          disabled={!apiKey.trim() || !baseUrl.trim() || !model.trim()}
          onClick={() =>
            onSave({
              baseUrl: baseUrl.trim(),
              apiKey: apiKey.trim(),
              model: model.trim(),
              protocol,
            })
          }
        >
          {saveLabel}
        </button>
        {onCancel && (
          <button className="btn btn-ghost" onClick={onCancel}>
            取消
          </button>
        )}
      </div>
    </div>
  )
}
