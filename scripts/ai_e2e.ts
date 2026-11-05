/* AI 城市生成端到端验证：真实调用大模型 → 生成城市素材 → 本地引擎编排 → 不变量校验 */
import { existsSync, readFileSync } from 'node:fs'
import { buildCityPack } from '../src/ai/cityBuilder'
import type { AIConfig } from '../src/ai/client'
import { generateTrip, type TripRequest } from '../src/engine/itinerary'
import type { BudgetStyle, Pace, Tag } from '../src/data/types'

/** 仅从本项目 local-secrets 读取显式配置；不读取其他软件的登录令牌。 */
function resolveConfig(): AIConfig | null {
  const file = new URL('../local-secrets/api-keys/ai.json', import.meta.url)
  if (!existsSync(file)) return null
  try {
    const cfg = JSON.parse(readFileSync(file, 'utf-8')) as AIConfig
    return cfg.apiKey && cfg.baseUrl && cfg.model ? cfg : null
  } catch { return null }
}

const cfg = resolveConfig()
if (!cfg) {
  console.error('未配置在线 AI 验证。请在本项目 local-secrets/api-keys/ai.json 填写 baseUrl、apiKey、model、protocol 后自行运行；该目录不得提交或打包。')
  process.exit(1)
}

const CITY = process.argv[2] ?? '洛阳'
const STYLES: BudgetStyle[] = ['thrifty', 'balanced', 'premium']
const PACES: Pace[] = ['packed', 'balanced', 'relaxed']
const PREF_SETS: Tag[][] = [[], ['food', 'history'], ['nature', 'photo'], ['family', 'indoor']]

function parseTime(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return h + m / 60
}

let issues = 0
const log: string[] = []
function fail(m: string) {
  issues++
  if (log.length < 30) log.push(m)
}

console.log(`▶ 目标城市：${CITY}`)
console.log(`▶ 模型：${cfg.model}（${cfg.protocol} 协议）\n`)

const t0 = Date.now()
const res = await buildCityPack(cfg, {
  cityName: CITY,
  days: 4,
  month: 10,
  budget: 6000,
  travelers: 2,
  style: 'balanced',
  pace: 'balanced',
  prefs: ['food', 'history'],
})
const { pack, issues: packIssues } = res
console.log(`◀ 生成耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，共 ${res.attempts} 次模型调用\n`)

console.log('── 生成的城市资料 ──')
console.log(`  简介：${pack.city.tagline}`)
console.log(`  经纬度：${pack.city.coordinates ? pack.city.coordinates.join(', ') : '（缺失）'}`)
console.log(`  景点 ${pack.attractions.length} 个 / 酒店 ${pack.hotels.length} 家 / 美食 ${pack.foods.length} 种 / 交通 ${pack.transit.length} 种`)
console.log(`  档次覆盖：${[...new Set(pack.hotels.map((h) => h.tier))].join('、')}`)
console.log(`  提示：${packIssues.notes.join('；') || '无'}`)
console.log('\n  景点清单：')
for (const a of pack.attractions) {
  const pos = `(${a.x}, ${a.y})`
  console.log(`    · ${a.name.padEnd(12, '　')} ${a.zone.padEnd(8, '　')} ${pos.padEnd(14, '　')} ${a.hours}h ¥${a.ticket} ${a.bestTime} ${a.tags.join('/')}`)
}
console.log('\n  酒店清单：')
for (const h of pack.hotels) {
  console.log(`    · ${h.name.padEnd(14, '　')} ${h.tier.padEnd(9, '　')} ¥${h.price}/晚 (${h.rating}) ${h.zone}`)
}
console.log('\n  美食清单：')
for (const f of pack.foods) console.log(`    · ${f.name} —— ${f.desc}（${f.price ?? ''}）`)

/* ---------- 素材级校验 ---------- */
if (pack.attractions.length < 10) fail(`景点不足 10 个（${pack.attractions.length}）`)
for (const a of pack.attractions) {
  if (!a.name) fail('存在空名景点')
  if (a.hours <= 0 || a.hours > 8) fail(`${a.name} hours 越界 ${a.hours}`)
  if (a.ticket < 0) fail(`${a.name} 负票价`)
  if (a.rating < 1 || a.rating > 5) fail(`${a.name} 评分越界 ${a.rating}`)
  if (Math.hypot(a.x, a.y) > 46) fail(`${a.name} 离中心过远 ${Math.hypot(a.x, a.y).toFixed(1)}km`)
  if (!a.zone) fail(`${a.name} 缺片区`)
}
const tiers = new Set(pack.hotels.map((h) => h.tier))
for (const t of ['budget', 'comfort', 'premium'] as const) {
  if (!tiers.has(t)) fail(`缺少 ${t} 档住宿`)
}
for (const h of pack.hotels) {
  if (h.price <= 0) fail(`${h.name} 价格异常`)
  if (!h.name) fail('存在空名酒店')
}

/* ---------- 行程不变量校验 ---------- */
let cases = 0
for (const days of [2, 3, 5, 7]) {
  for (const style of STYLES) {
    for (const pace of PACES) {
      for (const prefs of PREF_SETS) {
        cases++
        const REQ: TripRequest = {
          cityId: pack.city.id,
          origin: '上海',
          days,
          budget: 8000,
          travelers: 2,
          style,
          pace,
          month: 6,
          prefs,
          includeTransport: true,
        }
        const plan = generateTrip(pack, REQ)
        const tag = `${CITY}/${days}天/${style}/${pace}`

        for (const d of plan.days) {
          let prev = -1
          for (const it of d.items) {
            const t = parseTime(it.startTime)
            if (t < prev - 0.01) fail(`${tag} D${d.day} 时间倒流 ${it.startTime}`)
            if (t < 0 || t > 23.99) fail(`${tag} D${d.day} 时间越界 ${it.startTime}`)
            prev = t
            const e = parseTime(it.endTime)
            if (e < t) fail(`${tag} D${d.day} 结束早于开始`)
            if (e > 23.99) fail(`${tag} D${d.day} 结束越界 ${it.endTime}`)
          }
          const ids = d.items.map((i) => i.attraction.id)
          if (new Set(ids).size !== ids.length) fail(`${tag} D${d.day} 重复景点`)

          for (let i = 0; i < d.items.length; i++) {
            for (let j = i + 1; j < d.items.length; j++) {
              const a = d.items[i].attraction
              const b = d.items[j].attraction
              const dd = Math.hypot(a.x - b.x, a.y - b.y)
              if (dd > 15.01) fail(`${tag} D${d.day} 同日间距 ${dd.toFixed(1)}km > 15km`)
            }
          }

          const ev = d.items.filter((i) => i.attraction.bestTime === 'evening').length
          if (ev > 1) fail(`${tag} D${d.day} 夜间点 ${ev} 个`)

          const cap = { packed: 5, balanced: 3, relaxed: 2 }[pace]
          if (d.items.length > cap) fail(`${tag} D${d.day} 点位 ${d.items.length} > ${cap}`)

          // 每天游玩时长上限
          const maxHours = { packed: 11, balanced: 8.5, relaxed: 6 }[pace]
          const playHours = d.items.reduce((s, i) => s + i.attraction.hours, 0)
          if (playHours > maxHours + 0.01) {
            fail(`${tag} D${d.day} 游玩时长 ${playHours}h > 上限 ${maxHours}h`)
          }

          // 22:30 收工线
          for (const it of d.items) {
            if (parseTime(it.endTime) > 22.5 + 1e-6) {
              fail(`${tag} D${d.day} 「${it.attraction.name}」结束 ${it.endTime} 超过 22:30`)
            }
          }

          // 景点之间不重叠
          for (let i = 1; i < d.items.length; i++) {
            const prevEnd = parseTime(d.items[i - 1].endTime)
            const curStart = parseTime(d.items[i].startTime)
            if (curStart < prevEnd - 0.02) {
              fail(`${tag} D${d.day} 「${d.items[i].attraction.name}」开始早于上一个点结束`)
            }
          }

          // 路上时间必须体现在时间轴里
          for (let i = 1; i < d.items.length; i++) {
            const tr = d.items[i].transit
            if (!tr || tr.minutes <= 0) continue
            const from = parseTime(d.items[i - 1].endTime)
            if (parseTime(d.items[i].startTime) < from + tr.minutes / 60 - 0.02) {
              fail(`${tag} D${d.day} 「${d.items[i].attraction.name}」没算上 ${tr.minutes} 分钟路上时间`)
            }
          }

          // 餐点：不能与景点撞、不能与路上撞、彼此不能撞
          for (const m of d.meals) {
            const ms = parseTime(m.startTime)
            const me = parseTime(m.endTime)
            for (const it of d.items) {
              const is = parseTime(it.startTime)
              const ie = parseTime(it.endTime)
              if (ms < ie - 0.01 && is < me - 0.01) {
                fail(`${tag} D${d.day} 餐点「${m.name}」与景点时间重叠`)
              }
            }
            for (let i = 1; i < d.items.length; i++) {
              const tr = d.items[i].transit
              if (!tr || tr.minutes <= 0) continue
              const from = parseTime(d.items[i - 1].endTime)
              const to = from + tr.minutes / 60
              if (ms < to - 0.01 && me > from + 0.01) {
                fail(`${tag} D${d.day} 餐点「${m.name}」与路上时间重叠`)
              }
            }
          }
          for (let i = 1; i < d.meals.length; i++) {
            if (parseTime(d.meals[i].startTime) < parseTime(d.meals[i - 1].endTime) - 0.02) {
              fail(`${tag} D${d.day} 餐点「${d.meals[i].name}」与上一餐重叠`)
            }
          }

          // 坐标必须有限 —— 路线图直接拿 x/y 画 SVG
          for (const it of d.items) {
            const a = it.attraction
            if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) {
              fail(`${tag} D${d.day} ${a.name} 坐标非法 (${a.x}, ${a.y})`)
            }
          }

          if (d.transitCost < 0) fail(`${tag} 负交通费`)
        }

        if (!plan.lodging.hotel.name) fail(`${tag} 无住宿推荐`)
        const sum = plan.budgetItems.reduce((s, b) => s + b.amount, 0)
        if (Math.abs(sum - plan.totalBudget) > plan.totalBudget * 0.06) {
          fail(`${tag} 预算偏差 ${sum} vs ${plan.totalBudget}`)
        }
        for (let d = 0; d < plan.days.length; d++) {
          if (plan.days[d].items.length === 0 && d > 0 && plan.days[d - 1].items.length === 0) {
            fail(`${tag} 连续空天`)
          }
        }
      }
    }
  }
}

console.log(`\n── 行程校验：${cases} 组参数 ──`)
if (issues === 0) {
  console.log('✅ 全部通过，无异常')
} else {
  console.log(`❌ ${issues} 个问题：`)
  log.forEach((m) => console.log('  - ' + m))
  process.exitCode = 1
}
