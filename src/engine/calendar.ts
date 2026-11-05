/**
 * 把行程计划转成日历事件
 *
 * 景点和餐点都要进日历 —— 只导景点的话，用户会发现
 * 「午饭去哪」这件事还得自己另外安排，那导日历的意义就少了一半。
 */

import type { TripPlan } from './itinerary'
import { addDays, parseISO } from '../utils/date'
import { icsDateTime, type IcsEvent } from '../utils/ics'

/**
 * 生成日历事件
 *
 * @param plan 行程计划
 * @returns 事件列表；没有出发日期时返回空数组（无法确定哪一天）
 */
export function buildPlanEvents(plan: TripPlan): IcsEvent[] {
  const startDate = plan.request.startDate
  // 出发日期必须是真的日期 —— 否则会产出 notadateT090000 这种非法时间戳，
  // 导入日历时直接被解析器丢掉（用户会以为「导出没反应」）。
  // 引擎那层已经清洗过一次，这里再挡一道。
  if (!startDate || !parseISO(startDate)) return []

  const identity = (value: string) => Array.from(value).map(ch => ch.codePointAt(0)!.toString(16)).join('-')
  const city = identity(plan.request.cityId)
  const events: IcsEvent[] = []
  for (const day of plan.days) {
    const date = addDays(startDate, day.day - 1)

    day.items.forEach((item, i) => {
      const a = item.attraction
      const bits: string[] = [a.desc]
      if (a.tip) bits.push(`提示：${a.tip}`)
      if (a.ticket > 0) bits.push(`门票 ${a.ticket} 元`)
      if (a.needBooking) bits.push('需提前预约')
      events.push({
        uid: `tf-${city}-${date}-d${day.day}-a${i}-${identity(a.id)}@tripforge`,
        start: icsDateTime(date, item.startTime),
        end: icsDateTime(date, item.endTime),
        summary: a.name,
        description: bits.filter(Boolean).join('\n'),
        location: a.zone,
      })
    })

    day.meals.forEach((meal, i) => {
      const price = meal.priceText || `人均 ${meal.cost} 元`
      events.push({
        uid: `tf-${city}-${date}-d${day.day}-m${i}-${identity(meal.name)}@tripforge`,
        start: icsDateTime(date, meal.startTime),
        end: icsDateTime(date, meal.endTime),
        summary: `${meal.label}：${meal.name}`,
        description: [meal.desc, price].filter(Boolean).join('\n'),
        location: meal.zone,
      })
    })
  }

  return events
}

/** 日历文件名（去掉不适合文件名的字符） */
export function icsFileName(cityName: string, startDate: string): string {
  const safe = cityName.replace(/[\\/:*?"<>|\s]/g, '')
  return `行迹-${safe}-${startDate}.ics`
}
