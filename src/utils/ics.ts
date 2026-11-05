/**
 * 导出 .ics 日历文件（RFC 5545）
 *
 * 为什么自己写而不引库：项目零运行时依赖是刻意的约束，
 * 而 .ics 的核心就是「几个 VEVENT + 转义 + 折行」，不值得为它加一个依赖。
 *
 * 两个容易踩的坑，这里都处理了：
 *   1) **折行**：RFC 5545 规定每行不超过 75 字节，超了要在 75 字节处断行，
 *      续行以一个空格开头。中文字符 UTF-8 占 3 字节，很容易超。
 *   2) **转义**：TEXT 值里的 `\` `;` `,` 和换行必须转义，否则解析器会把
 *      一个「小龙坎，火锅」拆成两个字段。
 *
 * 时区：用**浮动时间**（不带 TZID、不带 Z），也就是「11 月 5 日 09:00 在你的日历上」。
 * 目的地和出发地往往不在同一个时区，写死 TZID 反而会把时间挪掉 1-2 小时，
 * 对旅行日程来说，「当地 9 点开始」比「精确到 UTC 的那一秒」更有用。
 */

/** 一个日历事件 */
export interface IcsEvent {
  /** 全局唯一 id */
  uid: string
  /** 开始时间 YYYY-MM-DDTHH:MM:SS（本地浮动时间，不带时区） */
  start: string
  /** 结束时间 YYYY-MM-DDTHH:MM:SS */
  end: string
  /** 标题 */
  summary: string
  /** 描述（可选） */
  description?: string
  /** 地点（可选） */
  location?: string
}

/** TEXT 值转义 */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
}

/**
 * 按 UTF-8 字节数折行（RFC 5545：每行 ≤75 字节，续行以空格开头）
 */
function foldLine(line: string): string {
  const encoder = new TextEncoder()
  if (encoder.encode(line).length <= 75) return line

  const out: string[] = []
  let current = ''
  let currentBytes = 0
  // 续行的第一个字符是空格，所以首行能用 75 字节，续行只能用 74
  for (const ch of line) {
    const size = encoder.encode(ch).length
    const limit = out.length === 0 ? 75 : 74
    if (currentBytes + size > limit) {
      out.push(current)
      current = ''
      currentBytes = 0
    }
    current += ch
    currentBytes += size
  }
  if (current) out.push(current)
  // 续行前加空格
  return out.map((l, i) => (i === 0 ? l : ` ${l}`)).join('\r\n')
}

/** UTC 时间戳（DTSTAMP 必须用 UTC） */
function dtStamp(now = new Date()): string {
  // toISOString() 自带结尾的 Z，别再补一个 —— 补了会变成 ...ZZ，部分解析器会直接拒收
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '') + 'Z'
}

/** HH:MM → HHMMSS */
function hms(hhmm: string): string {
  const [h, m] = hhmm.split(':')
  return `${h.padStart(2, '0')}${m.padStart(2, '0')}00`
}

/**
 * 生成 .ics 文本
 *
 * @param events  事件列表
 * @param calendarName 日历名（会显示在订阅列表里）
 */
export function buildICS(events: IcsEvent[], calendarName: string): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//TripForge//TripForge//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendarName)}`,
  ]

  const stamp = dtStamp()
  for (const ev of events) {
    lines.push('BEGIN:VEVENT')
    lines.push(`UID:${ev.uid}`)
    lines.push(`DTSTAMP:${stamp}`)
    lines.push(`DTSTART:${ev.start}`)
    lines.push(`DTEND:${ev.end}`)
    lines.push(`SUMMARY:${escapeText(ev.summary)}`)
    if (ev.description) lines.push(`DESCRIPTION:${escapeText(ev.description)}`)
    if (ev.location) lines.push(`LOCATION:${escapeText(ev.location)}`)
    lines.push('TRANSP:OPAQUE')
    lines.push('END:VEVENT')
  }

  lines.push('END:VCALENDAR')
  // RFC 5545 要求 CRLF 换行
  return lines.map(foldLine).join('\r\n') + '\r\n'
}

/** YYYY-MM-DD + HH:MM → YYYY-MM-DDTHH:MM:SS */
export function icsDateTime(dateISO: string, hhmm: string): string {
  return `${dateISO.replace(/-/g, '')}T${hms(hhmm)}`
}

/**
 * 触发浏览器下载
 *
 * @param content .ics 文本
 * @param filename 文件名
 */
export function downloadICS(content: string, filename: string): void {
  // 加 UTF-8 BOM：Windows 上的 Outlook / 部分日历 app 不带 BOM 会把中文显示成乱码
  // 用显式转义而不是直接写 BOM 字符 —— 后者在编辑器里是看不见的，
  // 很容易在改这一行时被悄悄删掉
  const blob = new Blob(['\uFEFF', content], {
    type: 'text/calendar;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // 立刻 revoke 会让部分浏览器拿不到内容，延后一拍
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}
