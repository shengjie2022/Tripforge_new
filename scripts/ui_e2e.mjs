/**
 * UI 端到端验证（Chrome + CDP）
 *
 * 跑之前先起开发服务器：
 *   npm run dev
 *
 * 然后：
 *   node scripts/ui_e2e.mjs
 *
 * 可用环境变量：
 *   BASE_URL    默认 http://127.0.0.1:5180
 *   CHROME_PATH Chrome 可执行文件路径（不填会自己找）
 *   CDP_PORT    默认 9338
 *
 * 为什么要自己驱动 Chrome：
 *   内置浏览器的合成/命中测试有缺陷，点不到页面元素；而且
 *   `chrome --headless --dump-dom` 只能验证渲染，验不了交互
 *   （React 的事件是异步 flush 的，脚本里 click 完立刻查 DOM 拿到的是旧状态）。
 *   所以这里用 CDP 发真实鼠标事件，跑完整链路。
 *
 * 验证点：
 *   1) 行程能渲染出来
 *   2) 天气卡片出现（拿不到天气也要静默降级，不能白屏）
 *   3) 餐点挂进日程，每天都有餐点行且带人均价
 *   4) 「导出日历 .ics」真的下载出文件，且内容合法
 *   5) 控制台没有报错
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE_URL =
  process.env.BASE_URL || 'http://127.0.0.1:5180'
const PORT = Number(process.env.CDP_PORT || 9338)
const SITE =
  `${BASE_URL}/?city=chengdu&from=%E4%B8%8A%E6%B5%B7&d=3&b=6000&p=2` +
  '&s=balanced&pace=balanced&m=10&prefs=food,history&start=2026-11-05'

/** 找 Chrome：环境变量优先，否则按常见安装位置找 */
function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    `${process.env.LOCALAPPDATA || ''}/Google/Chrome/Application/chrome.exe`,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ]
  for (const c of candidates) if (c && existsSync(c)) return c
  throw new Error('找不到 Chrome，用 CHROME_PATH 环境变量指定')
}

const profile = mkdtempSync(join(tmpdir(), 'tripforge-chrome-'))
const dlDir = mkdtempSync(join(tmpdir(), 'tripforge-dl-'))

const chrome = spawn(
  findChrome(),
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,2400',
    'about:blank',
  ],
  { stdio: 'ignore' }
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getJSON(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url)
      if (res.ok) return await res.json()
    } catch {
      /* 还没起来 */
    }
    await sleep(300)
  }
  throw new Error('Chrome 没起来: ' + url)
}

/** 极简 CDP 客户端 */
class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.events = []
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(JSON.stringify(msg.error)))
        else resolve(msg.result)
      } else if (msg.method) {
        this.events.push(msg)
      }
    })
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    this.ws.send(JSON.stringify(payload))
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error('CDP 超时: ' + method))
        }
      }, 30000)
    })
  }
}

let pass = 0
let failCount = 0
function check(name, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`  OK   ${name}${detail ? ' — ' + detail : ''}`)
  } else {
    failCount++
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`)
  }
}

try {
  const version = await getJSON(`http://127.0.0.1:${PORT}/json/version`)
  const ws = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', rej)
  })
  const cdp = new CDP(ws)

  // 允许下载到指定目录，才能验证 .ics 真的落盘
  await cdp.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: dlDir,
    eventsEnabled: true,
  })

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })

  await cdp.send('Runtime.enable', {}, sessionId)
  await cdp.send('Page.enable', {}, sessionId)
  await cdp.send('Log.enable', {}, sessionId)
  await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir }, sessionId)

  const evaluate = async (expression) => {
    // 导航后立刻求值时，渲染进程偶尔会卡一下（实测偶发 30s 无响应）。
    // 重试一次再判失败 —— 一个偶发失败的测试比没有测试更糟。
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await cdp.send(
          'Runtime.evaluate',
          { expression, returnByValue: true, awaitPromise: true },
          sessionId
        )
        if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
        return r.result.value
      } catch (e) {
        if (attempt === 1) throw e
        await sleep(1500)
      }
    }
  }

  console.log('>> 打开页面')
  await cdp.send('Page.navigate', { url: SITE }, sessionId)

  let days = 0
  for (let i = 0; i < 60; i++) {
    await sleep(500)
    days = await evaluate('document.querySelectorAll(".day").length')
    if (days > 0) break
  }
  check('行程渲染', days > 0, days + ' 天')

  console.log('>> 天气')
  let weather = null
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    weather = await evaluate(`(() => {
      const card = [...document.querySelectorAll('.card')].find(c => c.textContent.includes('出行天气'));
      if (!card) return null;
      return { hasMain: !!card.querySelector('.weather-main'), text: card.innerText.replace(/\\n+/g, ' | ').slice(0, 200) };
    })()`)
    if (weather && weather.hasMain) break
  }
  check('天气卡片出现且有内容', !!weather && weather.hasMain, weather ? weather.text : '未渲染')

  console.log('>> 路线图')
  const map = await evaluate(`(() => {
    const svg = document.querySelector('.map-svg');
    return {
      hasSvg: !!svg,
      chips: [...document.querySelectorAll('.map-chip')].map(c => c.innerText.trim()),
      paths: svg ? svg.querySelectorAll('path').length : 0,
      markers: svg ? svg.querySelectorAll('circle').length : 0,
      labels: svg ? svg.querySelectorAll('text').length : 0,
      spots: document.querySelectorAll('.day .stop').length,
    };
  })()`)
  check('路线图存在', map.hasSvg)
  check('有每天一个切换按钮', map.chips.length >= 2, map.chips.join(' / '))
  check('画出了折线', map.paths >= 1, map.paths + ' 条')
  check('标记数与景点数一致', map.markers === map.spots, map.markers + ' 标记 / ' + map.spots + ' 景点')

  // 点「第 2 天」聚焦
  const chipBox = await evaluate(`(() => {
    const b = [...document.querySelectorAll('.map-chip')].find(x => x.innerText.includes('第 2 天'));
    if (!b) return null;
    b.scrollIntoView({ block: 'center' });
    return { found: true };
  })()`)
  if (chipBox) {
    await sleep(800)
    const pos = await evaluate(`(() => {
      const b = [...document.querySelectorAll('.map-chip')].find(x => x.innerText.includes('第 2 天'));
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, h: window.innerHeight };
    })()`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y }, sessionId)
    await cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 },
      sessionId
    )
    await cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 },
      sessionId
    )
    await sleep(700)
    const focusState = await evaluate(`(() => ({
      on: [...document.querySelectorAll('.map-chip')].filter(c => c.classList.contains('on')).map(c => c.innerText.trim()),
      dashed: [...document.querySelectorAll('.map-svg path')].filter(p => p.getAttribute('stroke-dasharray')).length,
    }))()`)
    check('点第 2 天能聚焦', focusState.on.length === 1 && focusState.on[0].includes('第 2 天'), focusState.on.join(','))
    check('其余天淡出', focusState.dashed >= 1, focusState.dashed + ' 条虚线')
    // 复位
    await cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 },
      sessionId
    )
    await cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 },
      sessionId
    )
    await sleep(500)
  }

  console.log('>> 逐日天气')
  const daily = await evaluate(`(() => {
    const strip = document.querySelector('.weather-strip');
    const cells = [...document.querySelectorAll('.weather-day')].map(c => c.innerText.replace(/\\n+/g, ' '));
    const dayBadges = [...document.querySelectorAll('.day-weather')].map(c => c.innerText.replace(/\\n+/g, ' '));
    return {
      hasStrip: !!strip,
      cells,
      dayBadges,
      days: document.querySelectorAll('.day').length,
    };
  })()`)
  check('有逐日天气条', daily.hasStrip)
  check(
    '逐日条与行程天数一致',
    daily.cells.length === daily.days,
    daily.cells.length + ' 格 / ' + daily.days + ' 天'
  )
  check(
    '每天头部都挂了天气',
    daily.dayBadges.length === daily.days,
    daily.dayBadges.length + ' 个徽章'
  )
  if (daily.cells.length) console.log('       ' + daily.cells.join(' | '))
  if (daily.dayBadges.length) console.log('       ' + daily.dayBadges.join(' | '))

  console.log('>> 餐点')
  const meals = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.meal-row')];
    return {
      count: rows.length,
      days: document.querySelectorAll('.day').length,
      first: rows[0] ? rows[0].innerText.replace(/\\n+/g, ' | ') : '',
      hasCost: rows.every(r => /人均/.test(r.innerText)),
      distinct: new Set(rows.map(r => r.querySelector('.meal-name')?.innerText || '')).size,
    };
  })()`)
  check('有餐点行', meals.count > 0, meals.count + ' 行')
  check('每餐都标了人均价', meals.hasCost)
  check(
    '每天至少两餐',
    meals.count >= Math.max(1, meals.days - 1) * 2,
    meals.count + ' 行 / ' + meals.days + ' 天'
  )
  check('餐点不重样', meals.distinct >= 2, meals.distinct + ' 种不同菜')
  console.log('       首条: ' + meals.first)

  const dayMeta = await evaluate(
    "(() => { const d = document.querySelector('.day'); return d ? d.querySelector('.day-meta')?.innerText.replace(/\\n/g, ' | ') : '' })()"
  )
  check('当天概览含餐饮', /餐饮/.test(dayMeta), dayMeta)

  console.log('>> 导出日历')
  const hasBtn = await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('.ics'));
    if (!b) return null;
    b.scrollIntoView({ block: 'center' });
    return { text: b.textContent };
  })()`)
  check('找得到导出按钮', !!hasBtn, hasBtn ? hasBtn.text : '没找到')

  if (hasBtn) {
    // 滚动后要等一帧，getBoundingClientRect 才是滚动后的位置
    await sleep(800)
    const pos = await evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('.ics'));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, h: window.innerHeight };
    })()`)
    check('按钮在视口内', !!pos && pos.y > 0 && pos.y < pos.h, pos ? `y=${Math.round(pos.y)} 视口高=${pos.h}` : '无')

    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y }, sessionId)
    await cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 },
      sessionId
    )
    await cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 },
      sessionId
    )

    // 按钮反馈 2.2 秒后会复原，所以要早点看
    await sleep(700)
    const btnText = await evaluate(
      "[...document.querySelectorAll('button')].find(x => x.textContent.includes('已导出'))?.textContent || ''"
    )
    check('按钮给了反馈', btnText.includes('已导出'), btnText)
    await sleep(2500)

    const dlHome = join(process.env.USERPROFILE || process.env.HOME || '', 'Downloads')
    const found = []
    for (const dir of [dlDir, dlHome]) {
      if (!existsSync(dir)) continue
      for (const f of readdirSync(dir)) {
        if (f.endsWith('.ics')) found.push(join(dir, f))
      }
    }
    check('.ics 文件落盘', found.length > 0, found.join(','))

    if (found.length) {
      const content = readFileSync(found[0], 'utf8')
      check(
        'ICS 头正确',
        content.includes('BEGIN:VCALENDAR') && content.includes('END:VCALENDAR')
      )
      const evs = (content.match(/BEGIN:VEVENT/g) || []).length
      check('ICS 含事件', evs > 0, evs + ' 个事件')
      check('ICS 事件带日期', /DTSTART:\d{8}T\d{6}/.test(content))
      check('ICS 中文正常', content.includes('都江堰') || content.includes('熊猫'))
      const longLines = content.split('\r\n').filter((l) => Buffer.byteLength(l, 'utf8') > 75)
      check('ICS 每行 ≤75 字节', longLines.length === 0, longLines.length + ' 行超长')
    }
  }

  console.log('>> 常年值路径（出发日期远于 16 天）')
  // 这条路径之前是坏的：archive 接口的 end_date 用未来日期会直接 400，
  // 而代码里只有预报失败才会走常年值，所以一直没暴露。
  const FAR_SITE =
    `${BASE_URL}/?city=chengdu&from=%E4%B8%8A%E6%B5%B7&d=3&b=6000&p=2` +
    '&s=balanced&pace=balanced&m=3&prefs=food,history&start=2027-03-15'
  await cdp.send('Page.navigate', { url: FAR_SITE }, sessionId)
  let far = null
  for (let i = 0; i < 50; i++) {
    await sleep(500)
    far = await evaluate(`(() => {
      const card = [...document.querySelectorAll('.card')].find(c => c.textContent.includes('出行天气'));
      if (!card) return null;
      const cells = [...card.querySelectorAll('.weather-day')].map(c => c.innerText.replace(/\\n+/g, ' '));
      return { sub: card.querySelector('.card-sub')?.innerText || '', cells, text: card.innerText.slice(0, 160) };
    })()`)
    if (far && far.cells.length) break
  }
  check('常年值卡片出现', !!far && far.cells.length > 0, far ? far.text : '未渲染')
  check('标明是常年值不是预报', !!far && !far.sub.includes('预报'), far ? far.sub : '')
  check(
    '逐日标注了常年值口径',
    !!far && far.cells.every((c) => c.includes('常年值')),
    far ? far.cells.join(' | ') : ''
  )

  console.log('>> 非法出发日期')
  // start 参数是用户可编辑的输入，手改链接就能塞进任意字符串
  await cdp.send('Page.navigate', { url: `${BASE_URL}/?city=chengdu&d=2&start=abc` }, sessionId)
  await sleep(3500)
  const badDate = await evaluate(`(() => {
    const labels = [...document.querySelectorAll('.day-zone')].map(e => e.innerText);
    const heads = [...document.querySelectorAll('.day')].map(d => d.innerText.split('\\n').slice(0,2).join(' '));
    return { heads, broken: heads.filter(h => /（\\s*）/.test(h)).length };
  })()`)
  check('非法日期不产生空标签', badDate.broken === 0, badDate.heads.join(' | '))
  check('非法日期仍能出行程', badDate.heads.length > 0, badDate.heads.join(' | '))

  console.log('>> 非法 style / pace')
  // s 与 pace 是 URL 里可编辑的参数，手改就能塞进任意字符串。
  // 非法 style 以前会让 BUDGET_RATIO[style] 取到 undefined 直接白屏；
  // 非法 pace 更阴 —— `x > undefined` 恒为 false，每天点数与时长上限全部失效。
  for (const [label, qs] of [
    ['style', 's=foo'],
    ['pace', 'pace=foo'],
  ]) {
    await cdp.send('Page.navigate', { url: `${BASE_URL}/?city=chengdu&d=2&${qs}` }, sessionId)
    await sleep(3500)
    const bad = await evaluate(`(() => {
      const days = [...document.querySelectorAll('.day')];
      const meta = days.map(d => d.querySelector('.day-meta')?.innerText || '');
      // 游玩时长 = 各景点「建议 X 小时」之和（不含路上与用餐）
      const playHours = days.map(d => [...d.querySelectorAll('.stop-meta .pill')]
        .map(p => /建议\\s*([\\d.]+)\\s*小时/.exec(p.innerText || ''))
        .filter(Boolean)
        .map(m => Number(m[1]))
        .reduce((a, b) => a + b, 0));
      return {
        dayCount: days.length,
        stops: days.map(d => d.querySelectorAll('.stop').length),
        meta,
        playHours,
        text: document.body.innerText.replace(/\\n+/g, ' ').slice(0, 140),
      };
    })()`)
    check(`${label} 非法值不白屏`, bad.text.trim().length > 50, bad.text)
    check(`${label} 非法值仍出行程`, bad.dayCount === 2, `${bad.dayCount} 天`)
    // 非法值应回落到 balanced：每天 ≤ 3 个点、景点游玩时长 ≤ 8.5h
    check(
      `${label} 非法值时硬约束仍生效`,
      bad.stops.every((n) => n <= 3) && bad.playHours.every((h) => h <= 8.6),
      `点位 ${bad.stops.join(',')} 游玩 ${bad.playHours.join(',')}h`
    )
  }

  console.log('>> 控制台')
  const errs = cdp.events
    .filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
    .map((e) => e.params.args.map((a) => a.value || a.description || '').join(' '))
  const exceptions = cdp.events
    .filter((e) => e.method === 'Runtime.exceptionThrown')
    .map((e) => e.params.exceptionDetails?.exception?.description || 'exception')
  const allErrs = [...errs, ...exceptions]
  check('没有控制台报错', allErrs.length === 0, allErrs.slice(0, 3).join(' || '))

  console.log('\n' + (failCount === 0 ? '全部通过' : '有失败') + '：通过 ' + pass + '，失败 ' + failCount)
  process.exitCode = failCount === 0 ? 0 : 1
} catch (err) {
  console.error('E2E 失败:', err)
  process.exitCode = 1
} finally {
  try {
    chrome.kill()
  } catch {
    /* ignore */
  }
  // Windows 上 Chrome 可能还占着 profile 里的文件，立刻删会失败，
  // 所以先 kill 再等一拍，删不掉就重试几次 —— 否则 TEMP 会越攒越多
  const cleanup = (dir) => {
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
        return
      } catch {
        sleep(400)
      }
    }
  }
  await sleep(600)
  cleanup(profile)
  cleanup(dlDir)
}
