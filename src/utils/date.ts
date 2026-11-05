/**
 * 日期工具 —— 全站统一用「本地时区的 YYYY-MM-DD」字符串
 *
 * 约定：
 *   - 不带时区后缀，按浏览器本地时区解释
 *   - 不用 `new Date('2026-11-05')` 这种写法（会被当成 UTC，差 8 小时）
 *   - 一律自己拆年月日构造 Date，避免时区陷阱
 */

/** 今天的日期（YYYY-MM-DD） */
export function todayISO(): string {
  return toISO(new Date())
}

/** Date → YYYY-MM-DD（本地时区） */
export function toISO(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/**
 * YYYY-MM-DD → Date（本地时区零点）
 *
 * 非法输入返回 null。
 */
export function parseISO(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim())
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  const date = new Date(y, mo - 1, d)
  // 排除 2 月 30 日这类被 Date 自动进位的非法日期
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) {
    return null
  }
  return date
}

/** 日期加减天数（YYYY-MM-DD） */
export function addDays(iso: string, days: number): string {
  const d = parseISO(iso)
  if (!d) return iso
  d.setDate(d.getDate() + days)
  return toISO(d)
}

/** 「11 月 5 日」 */
export function formatCN(iso: string): string {
  const d = parseISO(iso)
  if (!d) return ''
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

/** 「周三」 */
export function weekdayCN(iso: string): string {
  const d = parseISO(iso)
  if (!d) return ''
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
}

/** 两个日期相差几天（b - a） */
export function daysBetween(a: string, b: string): number {
  const da = parseISO(a)
  const db = parseISO(b)
  if (!da || !db) return 0
  return Math.round((db.getTime() - da.getTime()) / 86400000)
}

/** 相对今天的建议出发日期（默认 30 天后，给用户留出订票时间） */
export function defaultStartDate(): string {
  const d = new Date()
  d.setDate(d.getDate() + 30)
  return toISO(d)
}
