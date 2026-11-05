/**
 * 可选的 AI 增强层
 *
 * 设计原则：**默认完全不用**。用户不填 Key，整个站点就是纯本地规则引擎，
 * 零网络请求、零配置、离线可用。
 *
 * 填了 Key 之后，额外做两件事：
 *   1. 让大模型基于已算好的行程数据，写一段更有人味的「出行提示」
 *   2. 让大模型为内置 16 城之外的目的地生成城市资料（见 cityBuilder.ts）
 *
 * Key 只保存在浏览器 localStorage，不会上传到任何第三方服务器；
 * 请求由浏览器直接发往用户自己填的 baseUrl。
 *
 * 支持两种接口协议：
 *   - openai：OpenAI 兼容（OpenAI / DeepSeek / 通义 / 智谱 / MiniMax 开放平台 ...）
 *   - anthropic：Anthropic 兼容（Claude 官方 / 各类 Claude Code 中转）
 */

/** 接口协议 */
export type AIProtocol = 'openai' | 'anthropic'

export interface AIConfig {
  baseUrl: string
  apiKey: string
  model: string
  protocol: AIProtocol
}

export const AI_PROTOCOL_LABELS: Record<AIProtocol, string> = {
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic 兼容',
}

const STORAGE_KEY = 'tripforge.ai.config'
let sessionConfig: AIConfig | null | undefined

export function loadAIConfig(): AIConfig | null {
  if (sessionConfig !== undefined) return sessionConfig
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const cfg = JSON.parse(raw) as AIConfig
    if (typeof cfg?.apiKey !== 'string' || !cfg.apiKey || typeof cfg.baseUrl !== 'string' || !cfg.baseUrl || typeof cfg.model !== 'string') return null
    // 老版本存的配置没有 protocol 字段，补默认
    if (!cfg.protocol) cfg.protocol = 'openai'
    return cfg
  } catch {
    return null
  }
}

export function saveAIConfig(cfg: AIConfig | null) {
  sessionConfig = cfg
  try {
    if (!cfg) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg))
    sessionConfig = undefined
  } catch {
    /* localStorage 不可用时静默降级 */
  }
}

export function clearAIConfig() {
  saveAIConfig(null)
}

/** Anthropic 协议必须带 max_tokens */
const DEFAULT_MAX_TOKENS = 32768

export interface ChatOptions {
  temperature?: number
  signal?: AbortSignal
  /** 额外的请求体字段 */
  extra?: Record<string, unknown>
}

/** 原始响应，同时带回结束原因（用来识别被长度截断） */
export interface RawChatResult {
  text: string
  /** openai: finish_reason；anthropic: stop_reason */
  finishReason: string
}

function httpError(status: number, statusText: string, body: string): Error {
  const err = new Error(
    `接口返回 ${status} ${statusText}${body ? `：${body.slice(0, 200)}` : ''}`
  ) as Error & { status?: number }
  err.status = status
  return err
}

/** 调用 OpenAI 兼容的 chat/completions 接口 */
async function chatOpenAI(
  cfg: AIConfig,
  system: string,
  user: string,
  opts: ChatOptions
): Promise<RawChatResult> {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`
  const body: Record<string, unknown> = {
    model: cfg.model,
    temperature: opts.temperature ?? 0.7,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    ...(opts.extra ?? {}),
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw httpError(res.status, res.statusText, text)
  }

  const json = await res.json()
  const choice = json?.choices?.[0]
  const content = choice?.message?.content
  if (typeof content !== 'string') throw new Error('返回格式不符合预期')
  return { text: content.trim(), finishReason: String(choice?.finish_reason ?? '') }
}

/** 调用 Anthropic 兼容的 messages 接口 */
async function chatAnthropic(
  cfg: AIConfig,
  system: string,
  user: string,
  opts: ChatOptions
): Promise<RawChatResult> {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/messages`
  const body: Record<string, unknown> = {
    model: cfg.model,
    max_tokens: DEFAULT_MAX_TOKENS,
    temperature: opts.temperature ?? 0.7,
    system,
    messages: [{ role: 'user', content: user }],
    ...(opts.extra ?? {}),
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // 两种鉴权头都带上：官方 Anthropic 看 x-api-key，各类中转看 Authorization
      'x-api-key': cfg.apiKey,
      Authorization: `Bearer ${cfg.apiKey}`,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw httpError(res.status, res.statusText, text)
  }

  const json = await res.json()
  const blocks = json?.content
  if (!Array.isArray(blocks)) throw new Error('返回格式不符合预期')
  // 有些模型会额外返回 thinking 块，只取 text
  const text = (blocks as { type?: string; text?: string }[])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
    .trim()
  if (!text) throw new Error('返回内容为空')
  return { text, finishReason: String(json?.stop_reason ?? '') }
}

/** 按配置协议调用大模型，返回原始结果 */
export function chatRaw(
  cfg: AIConfig,
  system: string,
  user: string,
  opts: ChatOptions = {}
): Promise<RawChatResult> {
  const endpoint = new URL(cfg.baseUrl)
  if (!['http:', 'https:'].includes(endpoint.protocol)) return Promise.reject(new Error('接口地址必须使用 http 或 https'))
  const timeout = AbortSignal.timeout(90000)
  const options = { ...opts, signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout }
  return cfg.protocol === 'anthropic'
    ? chatAnthropic(cfg, system, user, options)
    : chatOpenAI(cfg, system, user, options)
}

/** 按配置协议调用大模型 */
export async function chat(
  cfg: AIConfig,
  system: string,
  user: string,
  signal?: AbortSignal,
  extra?: Record<string, unknown>
): Promise<string> {
  const res = await chatRaw(cfg, system, user, {
    temperature: 0.7,
    signal,
    extra,
  })
  return res.text
}

/**
 * 根据行程数据，请模型写一份「出行提示」。
 * 只传入已计算好的结构化事实，避免模型编造事实性的门票/交通信息。
 */
export async function generateTravelNote(
  cfg: AIConfig,
  payload: {
    city: string
    days: number
    month: number
    budget: number
    travelers: number
    pace: string
    style: string
    prefs: string[]
    highlights: string[]
    route: string
    warnings: string[]
  },
  signal?: AbortSignal
): Promise<string> {
  const system = `你是一位资深旅行规划师。用户已经有一套由本地规则引擎算好的行程数据，
你的任务是**基于给定事实**写一段 150-250 字的出行提示，帮他们把行程执行好。

严格规则：
- 只能使用给定的事实，不得编造票价、开放时间、具体店名或交通班次
- 不要重复罗列景点清单（用户已经能看到），要讲"怎么执行"层面的事：时间怎么分配、注意什么、怎么避坑
- 语气实用、具体、不说空话，不要用"总而言之""值得注意的是"这类套话
- 直接输出正文，不要标题、不要 markdown 语法、不要前后缀说明

只输出正文段落。`

  const user = `目的地：${payload.city}
天数：${payload.days} 天｜出行月份：${payload.month} 月｜人数：${payload.travelers} 人
总预算：${payload.budget} 元｜节奏：${payload.pace}｜消费风格：${payload.style}
兴趣偏好：${payload.prefs.join('、') || '均衡'}

城市亮点：
${payload.highlights.map((h) => `- ${h}`).join('\n')}

行程主线：
${payload.route}

已识别的风险提示：
${payload.warnings.map((w) => `- ${w}`).join('\n') || '（无）'}

请基于以上信息写一段出行提示。`

  return chat(cfg, system, user, signal)
}
