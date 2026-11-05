/* 全量回归校验：所有城市 × 多组参数 */
import { CITY_PACKS } from '../src/data/index'
import {
  generateTrip,
  minDaysForMustVisit,
  type TripPlan,
  type TripRequest,
} from '../src/engine/itinerary'
import type { BudgetStyle, DailyWeather, Pace, Tag } from '../src/data/types'
import { buildPlanEvents } from '../src/engine/calendar'
import { buildICS } from '../src/utils/ics'
import { estimateFares } from '../src/engine/fare'
import { findOrigin } from '../src/data/origins'
import { haversine } from '../src/engine/geo'
import { searchCommons } from '../src/api/images'

const STYLES: BudgetStyle[] = ['thrifty', 'balanced', 'premium']
const PACES: Pace[] = ['packed', 'balanced', 'relaxed']
const PREF_SETS: Tag[][] = [
  [],
  ['food', 'history'],
  ['nature', 'photo', 'mountain'],
  ['family', 'indoor', 'relax'],
  ['night', 'shopping', 'local'],
]

let issues = 0
const issuesLog: string[] = []

function fail(msg: string) {
  issues++
  if (issuesLog.length < 30) issuesLog.push(msg)
}

function parseTime(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return h + m / 60
}

/**
 * 行程的通用不变量（与点选功能无关的部分，两套用例共用）
 *
 * allowConsecutiveEmpty：「只安排我选的」模式下，留白天数是预期结果，不算问题
 */
function checkPlanInvariants(
  plan: TripPlan,
  tag: string,
  allowConsecutiveEmpty = false
) {
  // 1) 时间轴单调
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
  }

  // 1.5) 路上时间必须体现在时间轴里 ——
  //      否则界面会显示「10:00 结束 A、10:00 开始 B」，中间那段地铁凭空消失
  for (const d of plan.days) {
    for (let i = 1; i < d.items.length; i++) {
      const tr = d.items[i].transit
      if (!tr || tr.minutes <= 0) continue
      const from = parseTime(d.items[i - 1].endTime)
      const start = parseTime(d.items[i].startTime)
      if (start < from + tr.minutes / 60 - 0.02) {
        fail(
          `${tag} D${d.day} 「${d.items[i].attraction.name}」开始时间没算上 ${tr.minutes} 分钟路上时间`
        )
      }
    }
  }

  // 1.6) 22:30 收工线 —— 之前是靠 grep 查的，没有断言兜着
  for (const d of plan.days) {
    for (const it of d.items) {
      if (parseTime(it.endTime) > 22.5 + 1e-6) {
        fail(`${tag} D${d.day} 「${it.attraction.name}」结束 ${it.endTime} 超过 22:30`)
      }
    }
  }

  // 1.7) 景点之间不重叠、不倒流
  for (const d of plan.days) {
    for (let i = 1; i < d.items.length; i++) {
      const prevEnd = parseTime(d.items[i - 1].endTime)
      const curStart = parseTime(d.items[i].startTime)
      if (curStart < prevEnd - 0.02) {
        fail(
          `${tag} D${d.day} 「${d.items[i].attraction.name}」${d.items[i].startTime} 早于上一个点的结束 ${d.items[i - 1].endTime}`
        )
      }
    }
  }

  // 1.8) 餐点之间不重叠、不倒流
  for (const d of plan.days) {
    for (let i = 1; i < d.meals.length; i++) {
      const prevEnd = parseTime(d.meals[i - 1].endTime)
      const curStart = parseTime(d.meals[i].startTime)
      if (curStart < prevEnd - 0.02) {
        fail(`${tag} D${d.day} 餐点「${d.meals[i].name}」${d.meals[i].startTime} 早于上一餐结束 ${d.meals[i - 1].endTime}`)
      }
    }
  }

  // 2) 同一天不能有重复景点
  for (const d of plan.days) {
    const ids = d.items.map((i) => i.attraction.id)
    if (new Set(ids).size !== ids.length) fail(`${tag} D${d.day} 重复景点`)
  }

  // 3) 同一天内任意两点距离不超过 15km（这是引擎的真实约束）
  for (const d of plan.days) {
    for (let i = 0; i < d.items.length; i++) {
      for (let j = i + 1; j < d.items.length; j++) {
        const a = d.items[i].attraction
        const b = d.items[j].attraction
        const dd = Math.hypot(a.x - b.x, a.y - b.y)
        if (dd > 15.01) {
          fail(`${tag} D${d.day} 同日间距 ${dd.toFixed(1)}km > 15km`)
        }
      }
    }
  }

  // 4) 每天夜间点不超过 1
  for (const d of plan.days) {
    const ev = d.items.filter((i) => i.attraction.bestTime === 'evening').length
    if (ev > 1) fail(`${tag} D${d.day} 夜间点 ${ev} 个`)
  }

  // 5) 每天点位数不超过上限
  const cap = { packed: 5, balanced: 3, relaxed: 2 }[plan.request.pace]
  for (const d of plan.days) {
    if (d.items.length > cap) fail(`${tag} D${d.day} 点位数 ${d.items.length} > ${cap}`)
  }

  // 5.5) 每天游玩时长不超过上限 ——
  //      兜底排程路径以前不查这一条，于是「紧凑暴走 11 小时 / 张弛有度 8.5 小时 /
  //      悠闲慢游 6 小时」这三个对外承诺在真实输出里不成立（实测单日超限最多 3.5 小时）
  const maxHours = { packed: 11, balanced: 8.5, relaxed: 6 }[plan.request.pace]
  for (const d of plan.days) {
    const h = d.items.reduce((s, i) => s + i.attraction.hours, 0)
    if (h > maxHours + 0.01) {
      fail(`${tag} D${d.day} 游玩时长 ${h}h > 上限 ${maxHours}h`)
    }
  }

  // 6) 交通费用非负
  for (const d of plan.days) {
    if (d.transitCost < 0) fail(`${tag} 负交通费`)
    for (const it of d.items) {
      if (it.transit && (it.transit.cost < 0 || it.transit.minutes < 0)) {
        fail(`${tag} 交通数据异常`)
      }
    }
  }

  // 6.5) 「共 X h」必须等于实际游玩时长 + 路上时间 ——
  //      不能用景点的名义时长：被 22:30 收工线截断的景点只玩了实际那么久，
  //      按名义算最多虚高 3.07h，还会误触发「一天超过 10 小时」的告警
  for (const d of plan.days) {
    const actual = d.items.reduce(
      (s, i) => s + (parseTime(i.endTime) - parseTime(i.startTime)),
      0
    )
    const travel = d.items.reduce((s, i) => s + (i.transit?.minutes ?? 0), 0) / 60
    const expect = Math.round((actual + travel) * 10) / 10
    if (Math.abs(d.hours - expect) > 0.11) {
      fail(`${tag} D${d.day} 共 ${d.hours}h != 实际 ${expect}h`)
    }
  }

  // 7) 住宿推荐存在，且晚数 = 天数 - 1
  if (!plan.lodging.hotel.name) fail(`${tag} 无住宿推荐`)
  const wantNights = Math.max(1, plan.days.length - 1)
  if (plan.lodging.nights !== wantNights) {
    fail(`${tag} 住宿晚数 ${plan.lodging.nights} != ${wantNights}`)
  }

  // 8) 预算明细合计接近总额，且各分项比例之和为 1
  const sum = plan.budgetItems.reduce((s, b) => s + b.amount, 0)
  if (Math.abs(sum - plan.totalBudget) > plan.totalBudget * 0.06) {
    fail(`${tag} 预算偏差 ${sum} vs ${plan.totalBudget}`)
  }
  const ratioSum = plan.budgetItems.reduce((s, b) => s + b.ratio, 0)
  if (Math.abs(ratioSum - 1) > 0.001) {
    fail(`${tag} 预算比例之和 ${ratioSum} != 1`)
  }

  // 9) 允许个别空天，但不能连续两天都空
  if (!allowConsecutiveEmpty) {
    for (let d = 0; d < plan.days.length; d++) {
      if (plan.days[d].items.length === 0) {
        const prevEmpty = d > 0 && plan.days[d - 1].items.length === 0
        if (prevEmpty) fail(`${tag} D${plan.days[d].day} 连续空天`)
      }
    }
  }

  // 9.5) 坐标必须是有限数 —— 路线图直接拿 x/y 画 SVG，
  //      出现 NaN 会让整张图渲染成空白
  for (const d of plan.days) {
    for (const it of d.items) {
      const a = it.attraction
      if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) {
        fail(`${tag} D${d.day} ${a.name} 坐标非法 (${a.x}, ${a.y})`)
      }
    }
  }
  const hb = plan.lodging.hotel
  if (hb?.name && (!Number.isFinite(hb.x) || !Number.isFinite(hb.y))) {
    fail(`${tag} 住宿坐标非法 (${hb.x}, ${hb.y})`)
  }

  // 10) 餐点：时间合法、餐次不重复、不与景点撞时间
  for (const d of plan.days) {
    const slotSeen = new Set<string>()
    for (const m of d.meals) {
      const ms = parseTime(m.startTime)
      const me = parseTime(m.endTime)
      if (ms < 0 || me > 23.99 || me < ms) {
        fail(`${tag} D${d.day} 餐点时间异常 ${m.startTime}-${m.endTime}`)
      }
      if (slotSeen.has(m.slot)) fail(`${tag} D${d.day} 餐次重复 ${m.slot}`)
      slotSeen.add(m.slot)
      for (const it of d.items) {
        const is = parseTime(it.startTime)
        const ie = parseTime(it.endTime)
        if (ms < ie - 0.01 && is < me - 0.01) {
          fail(`${tag} D${d.day} 餐点「${m.name}」与「${it.attraction.name}」时间重叠`)
        }
      }
    }
    // 11) 餐饮花费 = 三个餐次人均合计 × 人数（实测口径，不是拍脑袋的常量）
    //     注意是「三个餐次」，不是「排进日程的那几餐」——
    //     排不下的那顿你照样得吃，只算排出来的会让预算凭空少几百块
    const slotSum =
      d.mealSlotCosts.breakfast + d.mealSlotCosts.lunch + d.mealSlotCosts.dinner
    if (slotSum > 0) {
      const expect = slotSum * plan.request.travelers
      if (d.foodCost !== expect) {
        fail(`${tag} D${d.day} 餐饮 ${d.foodCost} != 实测 ${expect}`)
      }
      const placed = d.meals.reduce((s, m) => s + m.cost, 0) * plan.request.travelers
      if (placed > d.foodCost + 0.01) {
        fail(`${tag} D${d.day} 已排餐点费用 ${placed} 超过当日餐饮 ${d.foodCost}`)
      }
    }

    // 11.5) 餐点不能排在「正在路上」的那段时间里
    for (let i = 1; i < d.items.length; i++) {
      const tr = d.items[i].transit
      if (!tr || tr.minutes <= 0) continue
      const from = parseTime(d.items[i - 1].endTime)
      const to = from + tr.minutes / 60
      for (const m of d.meals) {
        const ms = parseTime(m.startTime)
        const me = parseTime(m.endTime)
        if (ms < to - 0.01 && me > from + 0.01) {
          fail(`${tag} D${d.day} 餐点「${m.name}」与路上时间重叠`)
        }
      }
    }
  }
}

let cases = 0

/* ------------------------------------------------------------------ *
 * 第一组：自动选点（原回归）
 * ------------------------------------------------------------------ */
for (const pack of CITY_PACKS) {
  for (const days of [1, 2, 3, 5, 7, 10]) {
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
          checkPlanInvariants(plan, `${pack.city.name}/${days}天/${style}/${pace}`)
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * 第二组：用户点选景点（好评榜）
 * ------------------------------------------------------------------ */
let pickCases = 0

for (const pack of CITY_PACKS) {
  const ids = pack.attractions.map((a) => a.id)
  const picks: string[][] = [
    ids.slice(0, 1),
    ids.slice(0, 3),
    ids.filter((_, i) => i % 3 === 0),
    ids.filter((_, i) => i % 2 === 1),
    ids,
  ]

  for (const must of picks) {
    for (const days of [1, 2, 4, 7]) {
      for (const pace of PACES) {
        pickCases++
        const REQ: TripRequest = {
          cityId: pack.city.id,
          origin: '上海',
          days,
          budget: 8000,
          travelers: 2,
          style: 'balanced',
          pace,
          month: 6,
          prefs: [],
          includeTransport: true,
          mustVisit: must,
        }
        const tag = `${pack.city.name}/选${must.length}个/${days}天/${pace}`
        const plan = generateTrip(pack, REQ)

        // 通用不变量同样成立（点选的点也不能破坏 15km / 夜间配额 / 每日点数）
        checkPlanInvariants(plan, tag)

        const picksInfo = plan.picks
        if (!picksInfo) {
          fail(`${tag} 缺少 picks 信息`)
        } else {
          const sel = new Set(picksInfo.selected)
          const placed = new Set(picksInfo.placed)
          const missing = new Set(picksInfo.missing)

          // 1) 三个集合必须自洽：placed ∪ missing = selected，且互不相交
          if (placed.size + missing.size !== sel.size) {
            fail(`${tag} picks 集合不自洽 placed=${placed.size} missing=${missing.size} selected=${sel.size}`)
          }
          for (const id of placed) if (!sel.has(id)) fail(`${tag} placed 里出现了未点选的点`)
          for (const id of missing) if (!sel.has(id)) fail(`${tag} missing 里出现了未点选的点`)

          // 2) placed 的点必须真的出现在行程里；missing 的点必须不在
          const inPlan = new Set(plan.days.flatMap((d) => d.items.map((i) => i.attraction.id)))
          for (const id of placed) if (!inPlan.has(id)) fail(`${tag} 标记为已排入但行程里没有`)
          for (const id of missing) if (inPlan.has(id)) fail(`${tag} 标记为排不下但行程里有`)

          // 3) 行程里带 picked 标记的点，必须都属于 placed
          for (const d of plan.days) {
            for (const it of d.items) {
              if (it.picked && !placed.has(it.attraction.id)) {
                fail(`${tag} D${d.day} ${it.attraction.name} 标了 picked 但不在 placed 里`)
              }
            }
          }
        }

        // 4) 「只安排我选的」模式：行程里只应有被点选的点
        const onlyPlan = generateTrip(pack, { ...REQ, onlyMustVisit: true })
        checkPlanInvariants(onlyPlan, `${tag}/只选`, true)
        const mustSet = new Set(must)
        for (const d of onlyPlan.days) {
          for (const it of d.items) {
            if (!mustSet.has(it.attraction.id)) {
              fail(`${tag}/只选 D${d.day} 出现了没点选的 ${it.attraction.name}`)
            }
          }
        }
        // 只选模式下排进去的点应当都是点选的
        for (const d of onlyPlan.days) {
          for (const it of d.items) {
            if (!it.picked) fail(`${tag}/只选 D${d.day} ${it.attraction.name} 缺 picked 标记`)
          }
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * 第三组：「建议天数」必须与引擎实际最少天数完全一致
 *
 * 之前建议天数比实际少 1-6 天（漏算夜间点配额 / 远郊不混排 / 自动选点挤占），
 * 用户照着改天数还是排不下。这条断言就是防止它再漂回去。
 * ------------------------------------------------------------------ */
let suggestCases = 0

for (const pack of CITY_PACKS) {
  const ids = pack.attractions.map((a) => a.id)
  const picks: string[][] = [ids.slice(0, 3), ids.filter((_, i) => i % 3 === 0)]

  for (const must of picks) {
    for (const pace of PACES) {
      suggestCases++
      const REQ: TripRequest = {
        cityId: pack.city.id,
        origin: '上海',
        days: 4,
        budget: 8000,
        travelers: 2,
        style: 'balanced',
        pace,
        month: 6,
        prefs: [],
        includeTransport: true,
      }
      const tag = `${pack.city.name}/选${must.length}个/${pace}`

      const need = minDaysForMustVisit(pack, REQ, must)

      // 引擎实际最少几天
      let actual = 0
      for (let d = 1; d <= 15; d++) {
        const plan = generateTrip(pack, { ...REQ, days: d, mustVisit: must })
        if (!plan.picks || plan.picks.missing.length === 0) {
          actual = d
          break
        }
      }

      if (actual === 0) {
        // 15 天都排不下 —— 引擎封顶 15 天，建议值也应是 15
        if (need !== 15) fail(`${tag} 15 天排不下，但建议 ${need} 天`)
        continue
      }
      if (need !== actual) fail(`${tag} 建议 ${need} 天 != 实际 ${actual} 天`)
    }
  }
}

/* ------------------------------------------------------------------ *
 * 第四组：.ics 日历导出
 *
 * 校验点：事件数量对得上、没有出发日期就不产出事件、
 * 生成的 ICS 每行不超过 75 字节（RFC 5545）、VEVENT 块字段齐全。
 * ------------------------------------------------------------------ */
let icsCases = 0

for (const pack of CITY_PACKS) {
  for (const days of [1, 3, 5]) {
    for (const pace of PACES) {
      icsCases++
      const REQ: TripRequest = {
        cityId: pack.city.id,
        origin: '上海',
        days,
        budget: 8000,
        travelers: 2,
        style: 'balanced',
        pace,
        month: 6,
        prefs: ['food', 'history'],
        includeTransport: true,
        startDate: '2026-11-05',
      }
      const tag = `${pack.city.name}/${days}天/${pace}`
      const plan = generateTrip(pack, REQ)

      const events = buildPlanEvents(plan)
      const spotCount = plan.days.reduce((s, d) => s + d.items.length, 0)
      const mealCount = plan.days.reduce((s, d) => s + d.meals.length, 0)
      if (events.length !== spotCount + mealCount) {
        fail(`${tag} 日历事件 ${events.length} != 景点 ${spotCount} + 餐点 ${mealCount}`)
      }

      // 没有出发日期 → 不该产出任何事件
      const noDatePlan = generateTrip(pack, {
        cityId: REQ.cityId,
        origin: REQ.origin,
        days: REQ.days,
        budget: REQ.budget,
        travelers: REQ.travelers,
        style: REQ.style,
        pace: REQ.pace,
        month: REQ.month,
        prefs: REQ.prefs,
        includeTransport: REQ.includeTransport,
      })
      if (buildPlanEvents(noDatePlan).length !== 0) {
        fail(`${tag} 没有出发日期却产出了日历事件`)
      }

      const ics = buildICS(events, `${pack.city.name} 行程`)
      if (!ics.endsWith('\r\n')) fail(`${tag} ICS 未以 CRLF 结尾`)
      const lines = ics.split('\r\n')
      if (lines[0] !== 'BEGIN:VCALENDAR') fail(`${tag} ICS 缺少 BEGIN:VCALENDAR`)
      const enc = new TextEncoder()
      for (const line of lines) {
        if (enc.encode(line).length > 75) fail(`${tag} ICS 有行超过 75 字节`)
      }
      const vevents = lines.filter((l) => l === 'BEGIN:VEVENT').length
      if (vevents !== events.length) fail(`${tag} VEVENT ${vevents} != 事件 ${events.length}`)
      // 每个 VEVENT 块必须有 UID / DTSTART / DTEND / SUMMARY
      let inEvent = false
      let seen = { uid: false, start: false, end: false, summary: false }
      for (const line of lines) {
        if (line === 'BEGIN:VEVENT') {
          inEvent = true
          seen = { uid: false, start: false, end: false, summary: false }
          continue
        }
        if (line === 'END:VEVENT') {
          inEvent = false
          if (!seen.uid || !seen.start || !seen.end || !seen.summary) {
            fail(`${tag} VEVENT 字段缺失`)
          }
          continue
        }
        if (!inEvent) continue
        if (line.startsWith('UID:')) seen.uid = true
        else if (line.startsWith('DTSTART:')) seen.start = true
        else if (line.startsWith('DTEND:')) seen.end = true
        else if (line.startsWith('SUMMARY:')) seen.summary = true
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * 第五组：逐日天气挂载
 *
 * 引擎不联网，天气是界面取到后塞进请求的。
 * 这里验的是「塞进来的逐日天气有没有按天对齐挂到 DayPlan 上」——
 * 错位一格就会让某天显示别人的天气。
 * ------------------------------------------------------------------ */
let weatherCases = 0

for (const pack of CITY_PACKS) {
  for (const days of [1, 3, 7]) {
    for (const pace of PACES) {
      weatherCases++
      const daily: DailyWeather[] = Array.from({ length: days }, (_, i) => ({
        date: `2026-11-${String(5 + i).padStart(2, '0')}`,
        high: 20 + i,
        low: 10 + i,
        precip: i % 3 === 0 ? 2 : 0,
        prob: i % 3 === 0 ? 60 : 10,
        rainy: i % 3 === 0,
        icon: '☀️',
        label: '晴',
        source: '预报',
      }))
      const REQ: TripRequest = {
        cityId: pack.city.id,
        origin: '上海',
        days,
        budget: 8000,
        travelers: 2,
        style: 'balanced',
        pace,
        month: 11,
        prefs: [],
        includeTransport: true,
        startDate: '2026-11-05',
        dailyWeather: daily,
      }
      const tag = `${pack.city.name}/${days}天/${pace}`
      const plan = generateTrip(pack, REQ)

      if (plan.days.length !== days) {
        fail(`${tag} 天数不对 ${plan.days.length} != ${days}`)
      }
      for (let i = 0; i < plan.days.length; i++) {
        const d = plan.days[i]
        if (!d.weather) {
          fail(`${tag} D${d.day} 没有挂上当天天气`)
          continue
        }
        if (d.weather.date !== daily[i].date) {
          fail(`${tag} D${d.day} 天气日期错位 ${d.weather.date} != ${daily[i].date}`)
        }
        if (d.weather.high !== daily[i].high) {
          fail(`${tag} D${d.day} 天气数值不一致`)
        }
      }

      // 没传天气时不应该凭空出现天气
      const noWeather = generateTrip(pack, {
        ...REQ,
        dailyWeather: undefined,
      })
      for (const d of noWeather.days) {
        if (d.weather) fail(`${tag}/无天气 D${d.day} 凭空挂了天气`)
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * 第六组：外部输入防御 + 口径对齐
 *
 * 这一组守的是「用户手改 URL」和「量纲不一致」两类问题：
 *   - 非法 style / pace 会让 BUDGET_RATIO / SPOTS_PER_DAY 取到 undefined，
 *     要么整页白屏，要么所有硬约束静默失效；
 *   - estimatedCost 漏掉往返大交通，却拿去跟「含大交通」的预算比，
 *     超支告警就成了一句空话。
 * ------------------------------------------------------------------ */
let guardCases = 0

for (const pack of CITY_PACKS) {
  const BASE_REQ: TripRequest = {
    cityId: pack.city.id,
    origin: '上海',
    days: 3,
    budget: 8000,
    travelers: 2,
    style: 'balanced',
    pace: 'balanced',
    month: 10,
    prefs: [],
    includeTransport: true,
  }
  const tag = `${pack.city.name}/防御`

  // 1) 非法 style / pace：不能抛异常，硬约束还得生效
  guardCases++
  try {
    const bad = generateTrip(pack, {
      ...BASE_REQ,
      style: 'foo' as never,
      pace: 'bar' as never,
    })
    const cap = { packed: 5, balanced: 3, relaxed: 2 }['balanced']
    const maxHours = { packed: 11, balanced: 8.5, relaxed: 6 }['balanced']
    for (const d of bad.days) {
      if (d.items.length > cap) fail(`${tag} 非法 pace 后点数 ${d.items.length} > ${cap}`)
      const h = d.items.reduce((s, i) => s + i.attraction.hours, 0)
      if (h > maxHours + 0.01) fail(`${tag} 非法 pace 后时长 ${h}h > ${maxHours}h`)
    }
  } catch (e) {
    fail(`${tag} 非法 style/pace 抛异常：${(e as Error).message}`)
  }

  // 2) estimatedCost 必须含往返大交通（includeTransport=true 时）
  guardCases++
  const withTransport = generateTrip(pack, { ...BASE_REQ, includeTransport: true })
  const expectWith =
    withTransport.lodging.totalCost +
    Math.round(withTransport.days.reduce((s, d) => s + d.transitCost, 0)) +
    withTransport.days.reduce((s, d) => s + d.foodCost, 0) +
    withTransport.days.reduce((s, d) => s + d.ticketCost, 0) +
    withTransport.transitPlan.arrival.cost
  if (withTransport.estimatedCost !== expectWith) {
    fail(`${tag} estimatedCost ${withTransport.estimatedCost} != 含大交通口径 ${expectWith}`)
  }

  // 3) 不含大交通时不该把往返算进去
  guardCases++
  const noTransport = generateTrip(pack, { ...BASE_REQ, includeTransport: false })
  const expectNo =
    noTransport.lodging.totalCost +
    Math.round(noTransport.days.reduce((s, d) => s + d.transitCost, 0)) +
    noTransport.days.reduce((s, d) => s + d.foodCost, 0) +
    noTransport.days.reduce((s, d) => s + d.ticketCost, 0)
  if (noTransport.estimatedCost !== expectNo) {
    fail(`${tag} 不含大交通时 estimatedCost ${noTransport.estimatedCost} != ${expectNo}`)
  }

  // 4) 非法 startDate 不能污染日历导出
  guardCases++
  const badDate = generateTrip(pack, { ...BASE_REQ, startDate: 'not-a-date' })
  if (badDate.request.startDate !== undefined) {
    fail(`${tag} 非法 startDate 仍写回 plan.request（${badDate.request.startDate}）`)
  }
  if (buildPlanEvents(badDate).length !== 0) {
    fail(`${tag} 非法 startDate 仍产出了日历事件`)
  }

  // 5) 逐日天气少一天时不能整体错位（按日期挂载，不是按数组下标）
  guardCases++
  const full: DailyWeather[] = Array.from({ length: 3 }, (_, i) => ({
    date: `2026-11-${String(5 + i).padStart(2, '0')}`,
    high: 20 + i,
    low: 10 + i,
    precip: 0,
    prob: 10,
    rainy: false,
    icon: '☀️',
    label: '晴',
    source: '预报',
  }))
  const shortPlan = generateTrip(pack, {
    ...BASE_REQ,
    days: 3,
    startDate: '2026-11-05',
    dailyWeather: full.slice(1),
  })
  for (const d of shortPlan.days) {
    const expect = full.find((w) => w.date === `2026-11-${String(4 + d.day).padStart(2, '0')}`)
    if (expect && d.weather && d.weather.date !== expect.date) {
      fail(`${tag} D${d.day} 天气错位 ${d.weather.date} != ${expect.date}`)
    }
    if (!expect && d.weather) {
      fail(`${tag} D${d.day} 缺数据却挂了天气 ${d.weather.date}`)
    }
  }
}

/* ------------------------------------------------------------------ *
 * 第七组：退化输入 + 跨模块口径一致
 * ------------------------------------------------------------------ */
let consistencyCases = 0

for (const pack of CITY_PACKS) {
  const BASE_REQ: TripRequest = {
    cityId: pack.city.id,
    origin: '上海',
    days: 3,
    budget: 8000,
    travelers: 2,
    style: 'balanced',
    pace: 'balanced',
    month: 10,
    prefs: [],
    includeTransport: true,
  }
  const tag = `${pack.city.name}/一致性`

  // 1) 非整数天数不能崩 ——
  //    Array.from({length: 3.5}) 只有 3 个元素，但循环边界 d < days 会走到下标 3，
  //    buckets[3] 是 undefined → TypeError → 没有 ErrorBoundary → 整页白屏
  consistencyCases++
  try {
    const plan = generateTrip(pack, { ...BASE_REQ, days: 3.5 })
    if (plan.days.length !== 4) {
      fail(`${tag} 非整数天数 ${plan.days.length} != 4`)
    }
  } catch (e) {
    fail(`${tag} 非整数天数抛异常：${(e as Error).message}`)
  }

  // 2) 退化预算 / 人数要被夹回合理区间
  consistencyCases++
  const weird = generateTrip(pack, {
    ...BASE_REQ,
    budget: 1.5,
    travelers: 0.5,
  })
  if (weird.totalBudget < 1000) fail(`${tag} 预算没夹回下限：${weird.totalBudget}`)
  if (weird.request.travelers < 1) fail(`${tag} 人数没夹回下限：${weird.request.travelers}`)
  for (const w of weird.warnings) {
    if (/高出\s*\d{5,}%/.test(w)) fail(`${tag} 出现离谱的超支百分比：${w}`)
  }

  // 3) 交通文案的首选方式 == 票价列表的第一条 ——
  //    同一张卡片上不能一边写「高铁为主」一边把飞机排在最前面
  for (const from of ['上海', '北京', '广州', '成都', '西安']) {
    consistencyCases++
    const o = findOrigin(from)
    const coords = pack.city.coordinates
    if (!o || !coords) continue
    const km = Math.round(haversine(o.coordinates, coords))
    const plan = generateTrip(pack, { ...BASE_REQ, origin: from })
    const copy = plan.transitPlan.arrival.mode
    const fares = estimateFares({
      fromCity: from,
      toCity: pack.city.name,
      km,
      overseas: pack.city.overseas,
      month: BASE_REQ.month,
      dateISO: '2026-11-05',
    })
    if (!fares.length) continue
    const prefersHighspeed = copy.includes('高铁')
    const prefersFlight = !prefersHighspeed && (copy.includes('直飞') || copy.includes('航班'))
    const expect = prefersHighspeed ? 'highspeed' : prefersFlight ? 'flight' : 'train'
    if (fares[0].mode !== expect) {
      fail(`${tag} ${from}→${pack.city.name} ${km}km 文案「${copy}」与列表首条「${fares[0].mode}」不一致`)
    }
  }
}

// 4) 图片接口：请求失败必须与「确实没找到」区分开
//    否则一次网络抖动会把空结果缓存 30 天，这个城市从此没有实景图且界面毫无提示
{
  const realFetch = globalThis.fetch
  consistencyCases++
  try {
    globalThis.fetch = (async () => {
      throw new Error('模拟网络失败')
    }) as typeof globalThis.fetch
    const failed = await searchCommons('成都', 4)
    if (failed !== null) {
      fail(`searchCommons 网络失败时应返回 null，实际返回 ${JSON.stringify(failed)?.slice(0, 40)}`)
    }
  } finally {
    globalThis.fetch = realFetch
  }

  consistencyCases++
  try {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ query: { pages: {} } }),
    })) as unknown as typeof globalThis.fetch
    const empty = await searchCommons('成都', 4)
    if (!Array.isArray(empty)) {
      fail('searchCommons 请求成功但无匹配时应返回数组')
    }
  } finally {
    globalThis.fetch = realFetch
  }
}

console.log(`运行 ${cases} 组参数 × ${CITY_PACKS.length} 城市`)
console.log(`运行 ${pickCases} 组点选场景 × ${CITY_PACKS.length} 城市`)
console.log(`运行 ${suggestCases} 组建议天数校验 × ${CITY_PACKS.length} 城市`)
console.log(`运行 ${icsCases} 组日历导出校验 × ${CITY_PACKS.length} 城市`)
console.log(`运行 ${weatherCases} 组逐日天气校验 × ${CITY_PACKS.length} 城市`)
console.log(`运行 ${guardCases} 组外部输入防御校验 × ${CITY_PACKS.length} 城市`)
console.log(`运行 ${consistencyCases} 组跨模块口径一致性校验`)
if (issues === 0) {
  console.log('✅ 全部通过，无异常')
} else {
  console.log(`❌ ${issues} 个问题：`)
  issuesLog.forEach((m) => console.log('  - ' + m))
  process.exitCode = 1
}
