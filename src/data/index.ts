import type { CityPack, CityRegistry } from './types'

import { chengdu } from './cities/chengdu'
import { xian } from './cities/xian'
import { hangzhou } from './cities/hangzhou'
import { dali } from './cities/dali'
import { xiamen } from './cities/xiamen'
import { changsha } from './cities/changsha'
import { qingdao } from './cities/qingdao'
import { chongqing } from './cities/chongqing'
import { beijing } from './cities/beijing'
import { lijiang } from './cities/lijiang'
import { kyoto } from './cities/kyoto'
import { bangkok } from './cities/bangkok'
import { singapore } from './cities/singapore'
import { paris } from './cities/paris'
import { bali } from './cities/bali'
import { seoul } from './cities/seoul'

export const CITY_PACKS: CityPack[] = [
  chengdu,
  xian,
  hangzhou,
  dali,
  xiamen,
  changsha,
  qingdao,
  chongqing,
  beijing,
  lijiang,
  kyoto,
  bangkok,
  singapore,
  paris,
  bali,
  seoul,
]

export const CITIES: CityRegistry = Object.fromEntries(
  CITY_PACKS.map((p) => [p.city.id, p])
)

/** 扁平化列表，便于搜索 */
export interface CityOption {
  id: string
  name: string
  enName: string
  country: string
  tagline: string
  tags: string[]
  overseas: boolean
  bestMonths: number[]
}

export const CITY_OPTIONS: CityOption[] = CITY_PACKS.map((p) => ({
  id: p.city.id,
  name: p.city.name,
  enName: p.city.enName,
  country: p.city.country,
  tagline: p.city.tagline,
  tags: p.city.tags,
  overseas: p.city.overseas,
  bestMonths: p.city.bestMonths,
}))

/** 关键词搜索：匹配中文名、英文名、别名、国家、标签 */
export function searchCities(keyword: string): CityOption[] {
  const kw = keyword.trim().toLowerCase()
  if (!kw) return CITY_OPTIONS
  return CITY_OPTIONS.filter((c) => {
    const hay = [c.name, c.enName, c.country, c.tagline, ...c.tags]
      .join(' ')
      .toLowerCase()
    return hay.includes(kw)
  })
}

export function getCityPack(id: string): CityPack | undefined {
  return CITIES[id]
}
