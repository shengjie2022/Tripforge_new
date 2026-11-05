import type { City } from './types'
import { CN_CITY_COORDS } from './origins-cn'

/**
 * 出发地候选列表 —— 用于估算往返大交通（飞行距离 / 铁路时长 / 票价区间）
 *
 * 由三部分组成：
 *   1. CURATED：人工维护的常用出发地（港澳台 + 热门县级市），坐标经过人工核对
 *   2. GENERATED：全国地级行政区（334 个），坐标取自 Wikidata 的 P625 坐标点
 *   3. 用户在界面上手动解析并保存的城市（县级市及以下），存在 localStorage
 *
 * 坐标顺序统一为 [纬度, 经度]（lat, lng），与 engine/geo.ts 的 haversine 入参一致。
 */
export interface OriginCity extends Pick<City, 'id' | 'name'> {
  /** 真实经纬度，顺序固定为 [纬度, 经度]（lat, lng），与 haversine 的入参一致 */
  coordinates: [number, number]
  /** 是否有高铁直达（目前引擎未用到，留作扩展） */
  hasHsr?: boolean
}

/** 人工维护的常用出发地 */
const CURATED: OriginCity[] = [
  { id: 'beijing', name: '北京', coordinates: [39.9042, 116.4074], hasHsr: true },
  { id: 'shanghai', name: '上海', coordinates: [31.2304, 121.4737], hasHsr: true },
  { id: 'guangzhou', name: '广州', coordinates: [23.1291, 113.2644], hasHsr: true },
  { id: 'shenzhen', name: '深圳', coordinates: [22.5431, 114.0579], hasHsr: true },
  { id: 'hangzhou', name: '杭州', coordinates: [30.2741, 120.1551], hasHsr: true },
  { id: 'chengdu', name: '成都', coordinates: [30.5728, 104.0665], hasHsr: true },
  { id: 'chongqing', name: '重庆', coordinates: [29.5630, 106.5516], hasHsr: true },
  { id: 'xian', name: '西安', coordinates: [34.3416, 108.9398], hasHsr: true },
  { id: 'nanjing', name: '南京', coordinates: [32.0603, 118.7969], hasHsr: true },
  { id: 'wuhan', name: '武汉', coordinates: [30.5928, 114.3055], hasHsr: true },
  { id: 'zhengzhou', name: '郑州', coordinates: [34.7466, 113.6254], hasHsr: true },
  { id: 'changsha', name: '长沙', coordinates: [28.2282, 112.9388], hasHsr: true },
  { id: 'jinan', name: '济南', coordinates: [36.6512, 117.1201], hasHsr: true },
  { id: 'tianjin', name: '天津', coordinates: [39.0842, 117.2008], hasHsr: true },
  { id: 'suzhou', name: '苏州', coordinates: [31.2989, 120.5853], hasHsr: true },
  { id: 'qingdao', name: '青岛', coordinates: [36.0671, 120.3826], hasHsr: true },
  { id: 'xiamen', name: '厦门', coordinates: [24.4798, 118.0894], hasHsr: true },
  { id: 'fuzhou', name: '福州', coordinates: [26.0745, 119.2965], hasHsr: true },
  { id: 'nanchang', name: '南昌', coordinates: [28.6820, 115.8581], hasHsr: true },
  { id: 'hefei', name: '合肥', coordinates: [31.8206, 117.2272], hasHsr: true },
  { id: 'guiyang', name: '贵阳', coordinates: [26.6477, 106.6302], hasHsr: true },
  { id: 'kunming', name: '昆明', coordinates: [24.8801, 102.8329], hasHsr: true },
  { id: 'lijiang', name: '丽江', coordinates: [26.8721, 100.2330], hasHsr: true },
  { id: 'dali', name: '大理', coordinates: [25.6065, 100.2676], hasHsr: true },
  { id: 'lanzhou', name: '兰州', coordinates: [36.0611, 103.8343], hasHsr: true },
  { id: 'xining', name: '西宁', coordinates: [36.6171, 101.7782], hasHsr: true },
  { id: 'urumqi', name: '乌鲁木齐', coordinates: [43.8256, 87.6168], hasHsr: true },
  { id: 'harbin', name: '哈尔滨', coordinates: [45.8038, 126.5349], hasHsr: true },
  { id: 'shenyang', name: '沈阳', coordinates: [41.8057, 123.4315], hasHsr: true },
  { id: 'dalian', name: '大连', coordinates: [38.9140, 121.6147], hasHsr: true },
  { id: 'taiyuan', name: '太原', coordinates: [37.8706, 112.5489], hasHsr: true },
  { id: 'hohhot', name: '呼和浩特', coordinates: [40.8414, 111.7519], hasHsr: true },
  { id: 'yinchuan', name: '银川', coordinates: [38.4872, 106.2789], hasHsr: true },
  { id: 'nanning', name: '南宁', coordinates: [22.8170, 108.3669], hasHsr: true },
  { id: 'haikou', name: '海口', coordinates: [20.0444, 110.1999], hasHsr: true },
  { id: 'sanya', name: '三亚', coordinates: [18.2479, 109.5083], hasHsr: false },
  { id: 'wuxi', name: '无锡', coordinates: [31.4912, 120.3119], hasHsr: true },
  { id: 'ningbo', name: '宁波', coordinates: [29.8683, 121.5497], hasHsr: true },
  { id: 'dongguan', name: '东莞', coordinates: [23.0207, 113.7518], hasHsr: true },
  { id: 'foshan', name: '佛山', coordinates: [23.0288, 113.1220], hasHsr: true },
  { id: 'yantai', name: '烟台', coordinates: [37.4638, 121.4479], hasHsr: true },
  { id: 'luoyang', name: '洛阳', coordinates: [34.6630, 112.4344], hasHsr: true },
  { id: 'nanyang', name: '南阳', coordinates: [32.9991, 112.5293], hasHsr: true },
  { id: 'mianyang', name: '绵阳', coordinates: [31.4675, 104.6796], hasHsr: true },
  { id: 'leshan', name: '乐山', coordinates: [29.5820, 103.7613], hasHsr: true },
  { id: 'yanbian', name: '延吉', coordinates: [42.8912, 129.5088], hasHsr: true },
  { id: 'chengde', name: '承德', coordinates: [40.9541, 117.9624], hasHsr: true },
  { id: 'hongkong', name: '香港', coordinates: [22.3193, 114.1694], hasHsr: true },
  { id: 'macau', name: '澳门', coordinates: [22.1987, 113.5439], hasHsr: true },
]

/** 自动生成的地级行政区，补齐全国覆盖 */
const GENERATED: OriginCity[] = Object.entries(CN_CITY_COORDS)
  .filter(([name]) => !CURATED.some((c) => c.name === name))
  .map(([name, coordinates]) => ({ id: `cn-${name}`, name, coordinates }))

/** 全部可选出发地：人工维护的在前（保证默认排序靠前），生成的跟后 */
export const ORIGIN_CITIES: OriginCity[] = [...CURATED, ...GENERATED]

/** 用户手动解析并存下来的出发地（县级市及以下） */
const CUSTOM_KEY = 'tripforge.origins.custom.v1'

export function loadCustomOrigins(): OriginCity[] {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? (arr as OriginCity[]) : []
  } catch {
    return []
  }
}

export function saveCustomOrigin(o: OriginCity): void {
  try {
    const list = loadCustomOrigins().filter((x) => x.name !== o.name)
    list.push(o)
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(list.slice(-50)))
  } catch {
    /* localStorage 不可用时静默降级 */
  }
}

export function findOrigin(name: string): OriginCity | undefined {
  const kw = name.trim()
  if (!kw) return undefined
  return (
    ORIGIN_CITIES.find((o) => o.name === kw) ??
    loadCustomOrigins().find((o) => o.name === kw)
  )
}

/**
 * 去掉行政后缀，让「温州市」「昆明市」能匹配到收录表里的「温州」「昆明」
 *
 * 刻意**不剥「州」**：广州 / 兰州 / 郑州 / 苏州 / 温州 里的「州」是名字的一部分，
 * 剥掉会变成「广」「兰」，反而匹配不上。
 */
export function normalizeOriginName(name: string): string {
  let n = name.trim()
  // 「XX地区」「XX盟」优先剥，否则「阿坝地区」剥成「阿坝地」
  for (const suffix of ['地区', '盟', '市', '县', '区']) {
    if (n.length > suffix.length + 1 && n.endsWith(suffix)) {
      n = n.slice(0, -suffix.length)
      break
    }
  }
  return n
}

/**
 * 在出发地候选里搜索
 *
 * 关键词为空时返回常用城市（人工维护的那批），
 * 有关键词时在全部候选（含用户自己保存的）里做包含匹配。
 *
 * 匹配做了后缀归一：「温州市」能命中「温州」，
 * 「临夏回族自治州」能命中「临夏」。
 */
export function searchOrigins(query: string, limit = 40): OriginCity[] {
  const kw = query.trim()
  const custom = loadCustomOrigins()
  const all = [...CURATED, ...custom, ...GENERATED]
  if (!kw) return CURATED.slice(0, limit)

  const k = normalizeOriginName(kw)
  const hits = all.filter((o) => {
    if (o.name.includes(kw)) return true
    const on = normalizeOriginName(o.name)
    if (on.includes(k)) return true
    // 「临夏回族自治州」→ 命中「临夏」
    return k.includes(on)
  })

  // 分级排序：人工维护 > 用户自存 > 自动生成；同级按名称长度（短的通常是地级市，更常用）
  const curatedSet = new Set(CURATED.map((c) => c.name))
  const customSet = new Set(custom.map((c) => c.name))
  const tier = (n: string) => (curatedSet.has(n) ? 0 : customSet.has(n) ? 1 : 2)
  hits.sort((a, b) => tier(a.name) - tier(b.name) || a.name.length - b.name.length)
  return hits.slice(0, limit)
}
