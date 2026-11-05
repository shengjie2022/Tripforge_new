/**
 * 目的地实景图检索（数据源：Wikimedia Commons）
 *
 * 为什么选 Wikimedia Commons：
 *   - 免费、开放，**不需要 API Key**，纯前端可以直接调，不用维护后端代理；
 *   - 接口返回 `access-control-allow-origin: *`，浏览器可直连（CORS 友好）；
 *   - 图库里是真的景点实拍照片，比占位图/AI 生成的图有用得多；
 *   - 元数据里带作者和许可协议，可以规范署名。
 *
 * 为什么每张图都要带 author + license：
 *   Commons 上的图绝大多数是 CC BY / CC BY-SA / 公有领域，
 *   **使用必须署名**。所以 PhotoItem 里 author / license 是必填项，
 *   页面展示时必须一起展示出来，不能只贴图。
 *
 * 局限（用之前先心里有数）：
 *   - 只能靠"名字检索"，Commons 没有「景点 ID → 图片」的结构化映射；
 *   - 不是每个景点都有照片，小众景点基本靠运气；
 *   - 搜出来的图和"这个景点"不保证一一对应，可能只是文件名里带了这个词；
 *   - 中文景点名的检索质量很依赖志愿者上传量，常搜到无关的扫描件。
 *
 * 本模块不依赖任何第三方库；缓存自己实现（不共用 src/ai/cache.ts），
 * 因为图片缓存的 key 结构和过期策略跟 AI 城市包不一样。
 */

import type { PhotoItem } from '../data/types'

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** Commons 检索接口 */
const API_ENDPOINT = 'https://commons.wikimedia.org/w/api.php'

/** localStorage 缓存 key 前缀 */
const CACHE_PREFIX = 'tripforge.photos.v1.'

/** 有图时的缓存有效期：30 天 */
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * 空结果缓存有效期：3 天
 *
 * 空结果要短命一点 —— 万一这次是检索词没命中（而不是真的没图），
 * 3 天后还会再试一次；30 天的话就是「这城没有实景图」被永久钉死。
 */
const EMPTY_TTL_MS = 3 * 24 * 60 * 60 * 1000

/** 单次请求超时 */
const REQUEST_TIMEOUT_MS = 8000

/** searchCommons 默认返回条数 */
const DEFAULT_LIMIT = 8

/** 向 Commons 申请的最大结果数（过滤之后通常会少于申请数） */
const MAX_SEARCH_LIMIT = 50

/** 一次 fetchCityPhotos 允许发出的最大网络请求数 */
const MAX_REQUESTS = 10

/** 每个检索词最多贡献几张（防止一个景点吃光整组画廊） */
const TERM_FETCH_LIMIT = 4

/** 理想宽高比：16:9 ≈ 1.78、4:3 ≈ 1.33，取中间值，越接近越靠前 */
const IDEAL_RATIO = 1.5

/** 竖图判定：height / width 超过此值丢弃（画廊是横向排版） */
const MAX_PORTRAIT_RATIO = 1.8

/** 最小尺寸门槛 */
const MIN_WIDTH = 800
const MIN_HEIGHT = 500

/** 作者/许可字段最大长度 */
const MAX_AUTHOR_LENGTH = 60

/**
 * 标题噪音黑名单（大小写不敏感，标题里包含即丢弃）
 *
 * Commons 搜索会混进大量非实景图：地图、拼图、印章、门票……
 * 这些都不是"景点实拍"，出现在画廊里很出戏。
 */
const TITLE_NOISE_WORDS = [
  'map',
  'montage',
  'logo',
  'diagram',
  'coat of arms',
  'flag',
  'poster',
  'banner',
  'icon',
  'stamp',
  'coin',
  'chart',
  'plan',
  'svg',
  'sign',
  'signage',
  'book',
  'cover',
  '拼图',
  '地图',
  '标志',
  '印章',
  '邮票',
  '门票',
  'ticket',
]

/**
 * 景点名里可以剥掉的后缀（用于生成更短的检索词）
 *
 * 只剥**一层**且剥完至少剩 2 个字，否则「黄山风景区」会被剥成「黄」。
 */
const ATTRACTION_SUFFIXES = [
  '风景区',
  '旅游区',
  '博物馆',
  '景区',
  '公园',
  '古城',
  '古镇',
  '瀑布',
  '草原',
  '湿地',
  '山',
  '寺',
  '庙',
  '宫',
  '塔',
  '陵',
  '园',
  '岛',
  '湖',
  '峡',
  '谷',
  '街',
  '广场',
  '遗址',
  '故居',
  '祠',
  '桥',
  '洞',
  '瀑',
  '泉',
  '岭',
  '楼',
  '阁',
  '海',
]

/* ------------------------------------------------------------------ *
 * 接口返回结构（只声明用到的字段）
 * ------------------------------------------------------------------ */

interface CommonsImageInfo {
  url?: string
  thumburl?: string
  descriptionurl?: string
  mime?: string
  width?: number
  height?: number
  extmetadata?: {
    Artist?: { value?: string }
    LicenseShortName?: { value?: string }
  }
}

interface CommonsPage {
  pageid?: number
  title?: string
  imageinfo?: CommonsImageInfo[]
}

interface CommonsResponse {
  query?: {
    pages?: Record<string, CommonsPage>
  }
}

interface PhotoCacheEntry {
  savedAt: number
  photos: PhotoItem[]
}

/* ------------------------------------------------------------------ *
 * 文本清洗
 * ------------------------------------------------------------------ */

/** 常见 HTML 实体表 */
const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
}

/** 反转义 HTML 实体：&amp; → &，&quot; → "，&#39; → ' …… */
function decodeEntities(input: string): string {
  return input.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi,
    (match: string, body: string): string => {
      const lower = body.toLowerCase()
      if (lower.startsWith('#x')) {
        const code = Number.parseInt(lower.slice(2), 16)
        return Number.isFinite(code) ? fromCodePoint(code) : match
      }
      if (lower.startsWith('#')) {
        const code = Number.parseInt(lower.slice(1), 10)
        return Number.isFinite(code) ? fromCodePoint(code) : match
      }
      return HTML_ENTITIES[lower] ?? match
    }
  )
}

function fromCodePoint(code: number): string {
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

/**
 * 整块去掉隐藏元素（含其内部文字）
 *
 * Commons 的 Artist 字段常写成
 *   `Unknown author<span style="display: none;">Unknown author</span>`
 * 直接剥标签会得到 "Unknown authorUnknown author"，
 * 所以先把 display:none 的元素**连内容一起**删掉。
 */
function removeHiddenBlocks(html: string): string {
  return html.replace(
    /<([a-z][a-z0-9]*)\b[^>]*display\s*:\s*none[^>]*>[\s\S]*?<\/\1\s*>/gi,
    ' '
  )
}

/** 剥掉所有 HTML 标签 */
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, ' ')
}

/** 折叠连续空白 */
function collapseSpace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** 清洗作者署名 */
function cleanAuthor(raw: string | undefined): string {
  if (!raw) return '未知作者'
  let out = removeHiddenBlocks(raw)
  out = stripTags(out)
  out = decodeEntities(out)
  out = collapseSpace(out)
  if (!out) return '未知作者'
  if (out.length > MAX_AUTHOR_LENGTH) {
    out = out.slice(0, MAX_AUTHOR_LENGTH).trim() + '…'
  }
  return out
}

/** 清洗许可协议短名 */
function cleanLicense(raw: string | undefined): string {
  if (!raw) return '见原始文件页'
  const out = collapseSpace(decodeEntities(stripTags(raw)))
  return out || '见原始文件页'
}

/** 清洗文件标题：去掉 File: 前缀，下划线换成空格 */
function cleanTitle(raw: string): string {
  return raw.replace(/^File:/i, '').replace(/_/g, ' ').trim()
}

/** descriptionurl 缺失时，自己拼一个文件页地址 */
function fallbackPageUrl(rawTitle: string): string {
  const fileName = rawTitle.replace(/^File:/i, '').trim().replace(/ /g, '_')
  return `https://commons.wikimedia.org/wiki/File:${fileName}`
}

/** 标题是否属于噪音（地图 / 拼图 / 印章 / 多图拼贴 ……） */
function isNoisyTitle(title: string): boolean {
  const lower = title.toLowerCase()
  for (const word of TITLE_NOISE_WORDS) {
    if (lower.includes(word)) return true
  }
  // "Guilin images.jpg" 这类多图拼贴（单数 image 可能是正常单图，不拦）
  if (/\bimages\b/.test(lower)) return true
  return false
}

/* ------------------------------------------------------------------ *
 * 检索
 * ------------------------------------------------------------------ */

/** 生成检索 URL */
function buildSearchUrl(term: string, limit: number): string {
  const params = [
    'action=query',
    'generator=search',
    `gsrsearch=${encodeURIComponent(term)}`,
    'gsrnamespace=6',
    `gsrlimit=${limit}`,
    'prop=imageinfo',
    'iiprop=url%7Cextmetadata%7Cmime%7Csize',
    'iiurlwidth=900',
    'format=json',
    'origin=*',
  ]
  return `${API_ENDPOINT}?${params.join('&')}`
}

/** 带超时的 AbortSignal；环境不支持 AbortSignal.timeout 时自己兜底 */
function createTimeout(ms: number): { signal: AbortSignal; cancel: () => void } {
  try {
    const factory = AbortSignal as unknown as { timeout?: (n: number) => AbortSignal }
    if (typeof factory.timeout === 'function') {
      return { signal: factory.timeout(ms), cancel: () => {} }
    }
  } catch {
    /* 环境不支持，落到下面的兜底实现 */
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  return { signal: controller.signal, cancel: () => { clearTimeout(timer) } }
}

/** 从接口返回里挑出可用的实景图 */
function pickPhotos(data: CommonsResponse, term: string, limit: number): PhotoItem[] {
  const pages = data?.query?.pages
  if (!pages || typeof pages !== 'object') return []

  const candidates: { photo: PhotoItem; width: number; height: number }[] = []

  for (const key of Object.keys(pages)) {
    const page = pages[key]
    if (!page) continue
    const info = page.imageinfo?.[0]
    if (!info) continue

    // 只接受 jpeg / png：PDF、djvu、svg 一律不要
    const mime = typeof info.mime === 'string' ? info.mime.toLowerCase() : ''
    if (mime !== 'image/jpeg' && mime !== 'image/png') continue

    const width = Number(info.width) || 0
    const height = Number(info.height) || 0
    if (width < MIN_WIDTH || height < MIN_HEIGHT) continue

    // 竖图丢弃（画廊是横向排版）
    if (height / width > MAX_PORTRAIT_RATIO) continue

    const title = cleanTitle(page.title ?? '')
    if (!title) continue
    if (isNoisyTitle(title)) continue

    const url = info.thumburl || info.url
    if (!url) continue

    const pageUrl = info.descriptionurl || fallbackPageUrl(page.title ?? '')

    candidates.push({
      photo: {
        url,
        pageUrl,
        title,
        author: cleanAuthor(info.extmetadata?.Artist?.value),
        license: cleanLicense(info.extmetadata?.LicenseShortName?.value),
        term,
      },
      width,
      height,
    })
  }

  // 宽高比越接近 1.5 越靠前，其次宽图靠前
  candidates.sort((a, b) => {
    const gapA = Math.abs(a.width / a.height - IDEAL_RATIO)
    const gapB = Math.abs(b.width / b.height - IDEAL_RATIO)
    if (gapA !== gapB) return gapA - gapB
    return b.width - a.width
  })

  // 按标题去重
  const seen = new Set<string>()
  const out: PhotoItem[] = []
  for (const item of candidates) {
    const key = collapseSpace(item.photo.title).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item.photo)
    if (out.length >= limit) break
  }
  return out
}

/**
 * 在 Wikimedia Commons 上检索一张实景图。
 *
 * **永不抛错**，但要区分两种「什么都没有」：
 *   - `null` = **请求失败**（网络断了 / 非 200 / JSON 解析失败）
 *   - `[]`   = **确实没有匹配**（请求成功，只是没搜到）
 *
 * 这个区别很要紧：把「请求失败」当成「没找到」再缓存起来，
 * 一次网络抖动就会让这个城市 30 天没有实景图（而且界面上没有任何报错）。
 */
export async function searchCommons(
  term: string,
  limit: number = DEFAULT_LIMIT
): Promise<PhotoItem[] | null> {
  try {
    const query = term.trim()
    if (!query) return []
    if (!Number.isFinite(limit) || limit <= 0) return []
    const cap = Math.min(MAX_SEARCH_LIMIT, Math.floor(limit))

    const { signal, cancel } = createTimeout(REQUEST_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(buildSearchUrl(query, cap), {
        signal,
        headers: { Accept: 'application/json' },
      })
    } finally {
      cancel()
    }

    if (!res.ok) return null
    const data = (await res.json()) as CommonsResponse
    return pickPhotos(data, query, cap)
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * 城市级聚合
 * ------------------------------------------------------------------ */

/** 剥掉景点名末尾的常见后缀，生成更短的检索词 */
function shortenAttraction(name: string): string {
  for (const suffix of ATTRACTION_SUFFIXES) {
    if (name.length > suffix.length + 1 && name.endsWith(suffix)) {
      return name.slice(0, name.length - suffix.length)
    }
  }
  return name
}

/**
 * 生成检索词表（有序）。
 *
 * 前 5 个景点各试 2 个词（景点全名 → 去掉后缀的短名），
 * 最后再试城市中文名和英文名。
 */
function buildTerms(
  cityName: string,
  enName: string,
  attractionNames: string[]
): string[] {
  const terms: string[] = []
  const push = (value: string): void => {
    const text = value.trim()
    if (text) terms.push(text)
  }

  for (const name of attractionNames.slice(0, 5)) {
    const full = name.trim()
    if (!full) continue
    push(full)
    push(shortenAttraction(full))
  }

  push(cityName)
  push(enName)

  return terms
}

/* ------------------------------------------------------------------ *
 * 缓存（自己实现，不共用 src/ai/cache.ts）
 * ------------------------------------------------------------------ */

function cacheKey(cityName: string): string {
  return CACHE_PREFIX + cityName.trim()
}

function readCache(cityName: string): PhotoItem[] | null {
  try {
    const raw = localStorage.getItem(cacheKey(cityName))
    if (!raw) return null
    const entry = JSON.parse(raw) as PhotoCacheEntry
    if (!entry || !Array.isArray(entry.photos)) return null
    const savedAt = Number(entry.savedAt) || 0
    const ttl = entry.photos.length === 0 ? EMPTY_TTL_MS : CACHE_TTL_MS
    if (Date.now() - savedAt > ttl) {
      localStorage.removeItem(cacheKey(cityName))
      return null
    }
    return entry.photos
  } catch {
    return null
  }
}

function writeCache(cityName: string, photos: PhotoItem[]): void {
  try {
    const entry: PhotoCacheEntry = { savedAt: Date.now(), photos }
    localStorage.setItem(cacheKey(cityName), JSON.stringify(entry))
  } catch {
    /* localStorage 不可用（隐私模式 / 配额不足）时静默降级 */
  }
}

/** 清掉某个城市的图片缓存 */
export function clearPhotoCache(cityName: string): void {
  try {
    localStorage.removeItem(cacheKey(cityName))
  } catch {
    /* ignore */
  }
}

/**
 * 取某个目的地的实景图集合。
 *
 * 按检索词表依次尝试，累积到 max 张为止（或词表用完）。
 * 命中缓存时直接返回，**不发任何网络请求**。
 */
export async function fetchCityPhotos(
  cityName: string,
  enName: string,
  attractionNames: string[],
  options?: { max?: number }
): Promise<PhotoItem[]> {
  const max = options?.max ?? DEFAULT_LIMIT

  const cached = readCache(cityName)
  if (cached) return cached

  const collected: PhotoItem[] = []
  /** 至少有一次请求成功 —— 只有成功过才允许写缓存 */
  let anySucceeded = false
  try {
    const terms = buildTerms(cityName, enName, attractionNames)
    const seenTerms = new Set<string>()
    const seenTitles = new Set<string>()
    let requests = 0

    for (const term of terms) {
      if (collected.length >= max) break
      if (requests >= MAX_REQUESTS) break
      if (seenTerms.has(term)) continue
      seenTerms.add(term)

      requests += 1
      const hits = await searchCommons(term, TERM_FETCH_LIMIT)
      // null = 这个词请求失败，跳过（不能当成「没找到」）
      if (hits === null) continue
      anySucceeded = true

      for (const photo of hits) {
        const key = collapseSpace(photo.title).toLowerCase()
        if (seenTitles.has(key)) continue
        seenTitles.add(key)
        collected.push(photo)
        if (collected.length >= max) break
      }
    }
  } catch {
    /* 出错就返回已经收集到的部分 */
  }

  // 空结果也缓存（短 TTL 3 天），避免每次访问都重发最多 10 个请求；
  // 但只有确实请求成功过才缓存 —— 网络抖动不算「这城没照片」，
  // 否则一次断网就会让这个城市 30 天没有实景图（界面上还看不出任何异常）
  if (anySucceeded) writeCache(cityName, collected)
  return collected
}
