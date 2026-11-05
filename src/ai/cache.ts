/**
 * AI 生成的城市素材包缓存
 *
 * 同一座城市生成一次就够了，没必要每次都烧 token。
 * 缓存在浏览器 localStorage里，30 天后过期（票价/开放时间会变）。
 */

import type { CityPack } from '../data/types'

const PREFIX = 'tripforge.ai.pack.v1.'
const TTL_DAYS = 30

interface CacheEntry {
  savedAt: number
  pack: CityPack
}

function key(cityName: string): string {
  return PREFIX + cityName.trim()
}

export function loadCachedPack(cityName: string): CityPack | null {
  try {
    const raw = localStorage.getItem(key(cityName))
    if (!raw) return null
    const entry = JSON.parse(raw) as CacheEntry
    if (!entry?.pack?.city || !Array.isArray(entry.pack.attractions)) return null
    const ageDays = (Date.now() - (entry.savedAt || 0)) / 86400000
    if (ageDays > TTL_DAYS) {
      localStorage.removeItem(key(cityName))
      return null
    }
    return entry.pack
  } catch {
    return null
  }
}

export function saveCachedPack(cityName: string, pack: CityPack) {
  try {
    const entry: CacheEntry = { savedAt: Date.now(), pack }
    localStorage.setItem(key(cityName), JSON.stringify(entry))
  } catch {
    /* 配额不足等场景静默降级 */
  }
}

export function clearCachedPack(cityName: string) {
  try {
    localStorage.removeItem(key(cityName))
  } catch {
    /* ignore */
  }
}

/** 列出所有缓存过的城市名 */
export function listCachedCities(): string[] {
  const out: string[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(PREFIX)) out.push(k.slice(PREFIX.length))
    }
  } catch {
    /* ignore */
  }
  return out
}
