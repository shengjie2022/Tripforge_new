/**
 * 大模型 JSON 调用的容错层
 *
 * 大模型返回的 JSON 不太听话，这里做四层兜底：
 *   1. OpenAI 协议优先用 response_format: json_object（部分服务商支持）
 *   2. 服务商不支持时，逐步降级：去掉 response_format → 换 max_completion_tokens → 裸调
 *   3. 识别「输出被长度截断」（openai finish_reason=length / anthropic stop_reason=max_tokens），
 *      抛专门的错误让上层换策略重试，而不是把半截 JSON 当成功
 *   4. 解析时容忍 ```json 包裹、前后废话、尾逗号、单引号
 *
 * Anthropic 协议没有 response_format，直接用提示词约束 + 容错解析。
 */

import { chatRaw, type AIConfig } from './client'

/** 输出被长度上限截断，调用方应该换策略（拆小、关思考、重试）而不是原样重试 */
export class TruncatedOutputError extends Error {
  finishReason: string

  constructor(finishReason: string) {
    super(`模型输出被长度上限截断（${finishReason}），JSON 不完整`)
    this.name = 'TruncatedOutputError'
    this.finishReason = finishReason
  }
}

export interface ChatJSONOptions {
  temperature?: number
  signal?: AbortSignal
  /** 强制不用 response_format */
  noResponseFormat?: boolean
  /**
   * 关闭模型思考模式（仅 Anthropic 协议）。
   * 部分模型强制 thinking（如 MiniMax-M3.1-Flash），带上会 400，所以只在重试时用。
   */
  disableThinking?: boolean
}

/** 输出的 token 上限，太小会把 JSON 截断 */
const MAX_TOKENS = 32768

/** 从可能夹杂废话的文本里抠出 JSON 文本 */
export function extractJSON(text: string): string {
  let s = text.trim()

  // 去掉 ```json ... ``` 代码围栏
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()

  // 直接能解析就返回
  try {
    JSON.parse(s)
    return s
  } catch {
    /* 继续找 */
  }

  // 找第一个 { 或 [ 到最后一个 } 或 ] 之间的内容
  const startObj = s.indexOf('{')
  const startArr = s.indexOf('[')
  let start = -1
  let end = -1
  if (startObj >= 0 && (startArr < 0 || startObj < startArr)) {
    start = startObj
    end = s.lastIndexOf('}')
  } else if (startArr >= 0) {
    start = startArr
    end = s.lastIndexOf(']')
  }
  if (start >= 0 && end > start) {
    const slice = s.slice(start, end + 1)
    try {
      JSON.parse(slice)
      return slice
    } catch {
      s = slice
    }
  }

  // 修常见的小毛病：尾逗号、单引号键
  const repaired = s
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/([{,]\s*)'([^']+)'\s*:/g, '$1"$2":')
  return repaired
}

/** 解析大模型返回的 JSON，失败时抛出可读错误 */
export function parseJSON<T>(text: string): T {
  const raw = extractJSON(text)
  try {
    return JSON.parse(raw) as T
  } catch {
    const preview = text.slice(0, 160).replace(/\s+/g, ' ')
    throw new Error(
      `模型返回的内容不是合法 JSON（${preview}${text.length > 160 ? '…' : ''}）`
    )
  }
}

/**
 * 调用大模型并要求返回 JSON。
 *
 * 降级链：越往后能力越弱但兼容性越好。
 * 只有 400/404/422（参数不被接受）才会降级，其余错误直接抛出。
 */
export async function chatJSON<T>(
  cfg: AIConfig,
  system: string,
  user: string,
  opts: ChatJSONOptions = {}
): Promise<T> {
  const isOpenAI = cfg.protocol !== 'anthropic'
  const baseExtra: Record<string, unknown> = {}
  if (opts.disableThinking && !isOpenAI) {
    baseExtra.thinking = { type: 'disabled' }
  }

  const extras: (Record<string, unknown> | undefined)[] = []
  if (isOpenAI) {
    if (!opts.noResponseFormat) {
      extras.push({
        ...baseExtra,
        response_format: { type: 'json_object' },
        max_tokens: MAX_TOKENS,
      })
    }
    extras.push({ ...baseExtra, max_tokens: MAX_TOKENS })
    extras.push({ ...baseExtra, max_completion_tokens: MAX_TOKENS })
    extras.push({ ...baseExtra })
  } else {
    extras.push({ ...baseExtra })
  }

  let lastErr: unknown
  for (const extra of extras) {
    try {
      const res = await chatRaw(cfg, system, user, {
        temperature: opts.temperature ?? 0.4,
        signal: opts.signal,
        extra,
      })
      if (res.finishReason === 'length' || res.finishReason === 'max_tokens') {
        throw new TruncatedOutputError(res.finishReason)
      }
      return parseJSON<T>(res.text)
    } catch (e) {
      if (e instanceof TruncatedOutputError) throw e
      lastErr = e
      const err = e as Error & { status?: number }
      const recoverable = err.status === 400 || err.status === 404 || err.status === 422
      if (!recoverable) throw e
      // 参数不被接受，换下一档更保守的请求继续
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}
