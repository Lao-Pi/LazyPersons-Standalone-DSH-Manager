// 考工记 · 本地服务 + 终端状态机。零依赖，只用 Node 标准库。
// 版权所有 © 2026 小寻 · MIT License（见上一层 LICENSE）
// 独立于 DSH：DSH 崩了或没开也能跑；只读 DSH 的数据，唯一写的地方是本目录下的「导出」和「回收」。
//
//   知者创物，巧者述之。——《考工记》
//   小寻，2026-10-13
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import * as health from './modules/health.mjs'
import * as logs from './modules/logs.mjs'
import * as plugins from './modules/plugins.mjs'

const DIR = import.meta.dirname
const EXPORT_DIR = path.join(DIR, '导出')
const RECYCLE = path.join(DIR, '回收')   // 删除 = 目录整体移进这里 + 配置另存一份，不做 rm
const PORT0 = 19390

/* ---------- 环境探测：所有路径都从参数/手写指路/环境变量/默认值推，不写死 ---------- */
// 顺序：--dsh-home 参数 → 旁边的 dsh-home.txt（一行路径）→ 环境变量 DSH_HOME → 默认 ~\.dsh
// 找不到时开场稿会把"找过哪些地方"全打出来——有人问"为什么检测不到"，答案就在那几行里
const DEFAULT_HOME = path.join(os.homedir(), '.dsh')
const manualHome = (() => {
  const i = process.argv.indexOf('--dsh-home')
  if (i > -1 && process.argv[i + 1]) return process.argv[i + 1]
  try {
    const f = path.join(DIR, 'dsh-home.txt')
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim().split('\n')[0].trim() || null
  } catch { /* 读不到就走后面的路 */ }
  return null
})()
const HOME = manualHome || process.env.DSH_HOME || DEFAULT_HOME
const APPDATA = process.env.APPDATA || path.join(os.homedir(), '.config')
const appLogs = path.join(APPDATA, '@deepseek-ai', 'dsh-desktop', 'logs')

const listDirs = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch { return [] } }

const profilesDir = path.join(HOME, 'profiles')
const runtimes = listDirs(path.join(HOME, 'dsh-runtimes')).map((r) => path.join(HOME, 'dsh-runtimes', r, 'dependencies', 'node', 'bin', 'node.exe')).filter((p) => fs.existsSync(p))

const env = {
  home: HOME,
  profiles: listDirs(profilesDir).map((name) => ({ name, dir: path.join(profilesDir, name), patchFile: path.join(profilesDir, name, 'cordis.patch.yml'), pluginsDir: path.join(profilesDir, name, 'plugins') })),
  runtimes,
  nodeExe: process.execPath,
  sessionsDir: path.join(HOME, 'sessions'),
  logsDir: fs.existsSync(appLogs) ? appLogs : path.join(HOME, 'logs'),
  canWriteLogs: (() => { try { fs.accessSync(fs.existsSync(appLogs) ? appLogs : HOME, fs.constants.W_OK); return true } catch { return false } })(),
  crashFiles: (() => { try { return fs.readdirSync(fs.existsSync(appLogs) ? appLogs : HOME).filter((f) => f.startsWith('crash-')) } catch { return [] } })(),
}

// 开场稿：这工具是什么、为什么叫这个名字（出处考据见 地图.md）
const QUOTE = [
  '▓ 考工记 · 开场 ▓',
  '',
  '《周礼》六官，冬官一篇汉初就亡佚了。河间献王刘德取《考工记》补入，',
  '后世因此管它叫《周礼·冬官考工记》。',
  '',
  '那部书记的是官营手工业的规矩：六类工种、三十个行当——',
  '车怎么造、铜锡怎么配（"六齐"是世界最早的合金配方）、',
  '国怎么营：方九里，旁三门，九经九纬。',
  '它不管造，它管量：拿定好的规范，去量做出来的东西合不合。',
  '',
  'DSH 崩了、起不来的时候，也要有这么一件东西：',
  '不先把它开起来，就能量一量它哪儿不合。',
  '',
  '它独立于 DSH 跑，只看不改——除了你亲手点名要删的那个插件。',
  '',
  fs.existsSync(env.home) ? `主目录 ${env.home}` : [
    `主目录没能用起来：最后定位到 ${HOME}，但那里没有 profiles 目录。`,
    '我把四处都摊开，每行都是刚才实查的：',
    `  ① --dsh-home 参数：${process.argv.indexOf('--dsh-home') > -1 ? '给了「' + (process.argv[process.argv.indexOf('--dsh-home') + 1] || '空') + '」' : '没传'}`,
    `  ② 旁边的 dsh-home.txt：${fs.existsSync(path.join(DIR, 'dsh-home.txt')) ? '有，里头写着「' + manualHome + '」' : '没有这个文件'}`,
    `  ③ 环境变量 DSH_HOME：${process.env.DSH_HOME ? '设了「' + process.env.DSH_HOME + '」' : '没设'}`,
    `  ④ 默认路径 ${DEFAULT_HOME}：目录${fs.existsSync(DEFAULT_HOME) ? '在' : '不在'}，里面的 profiles ${fs.existsSync(path.join(DEFAULT_HOME, 'profiles')) ? '在' : '不在'}`,
    '想手工指路：在 server.mjs 旁边建个 dsh-home.txt，里头写一行 DSH 主目录的完整路径。',
  ].join('\n'),
  `运行时 Node ${process.version} ｜ profile ${env.profiles.map((p) => p.name).join('/') || '无'} ｜ 崩溃报告 ${env.crashFiles.length} 份`,
  '',
]
const bootLines = QUOTE

/* ---------- 终端状态机 ---------- */
const MENU = ['要干什么？', '  [1] 体检        （DSH 完整度 + 错误日志分析）', '  [2] 插件管理    （清单 · 完整度 · 删除）', '  [0] 退出']
const CHECK = ['体检哪一块？', '  [1] 自动体检    （DSH 整体完整度）', '  [2] 错误日志分析（最新 5 份崩溃报告）', '  [0] 返回']

let S = { view: 'menu', rows: [], pick: 0 }
const reset = () => { S = { view: 'menu', rows: [], pick: 0 } }
const out = (lines, extra = {}) => ({ lines, ...extra })
const stamp = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` }

const pluginListLines = () => {
  if (!S.rows.length) return ['一个插件目录都没找到。', '', ...MENU]
  const lines = [`插件清单（${env.profiles.length} 个 profile，共 ${S.rows.length} 个插件）`, '']
  S.rows.forEach((r, i) => lines.push(`  [${i + 1}] ${r.name.padEnd(26)} 完整度 ${r.integ.score}/${r.integ.total}   (${r.prof.name})`))
  lines.push('', '输入编号看完整度明细；a 全体检测；0 返回。')
  return lines
}

const pluginDetailLines = (r) => {
  const lines = [`[${S.pick + 1}] ${r.name}   (profile ${r.prof.name})`, `  目录 ${r.dir}`, '']
  for (const c of r.integ.checks) lines.push(`  ${c.pass ? '[ OK ]' : '[ !! ]'} ${c.item}${c.note ? '   ' + c.note : ''}`)
  lines.push('', `  完整度 ${r.integ.score}/${r.integ.total}`)
  if (r.entry) lines.push(`  注册在 patch 第 ${r.entry.line + 1} 行（id=${r.entry.id}）`)
  lines.push('', '输入 d 删除这个插件；0 返回。')
  return lines
}

async function handle(text) {
  const t = text.trim().toLowerCase()

  if (t === 'menu' || t === 'm') { reset(); return out(MENU, { prompt: '考工记> ' }) }

  if (S.view === 'menu') {
    if (t === '1') { S.view = 'check'; return out(CHECK) }
    if (t === '2') { S.rows = plugins.inventory(env); S.pick = 0; S.view = 'plugin-list'; return out(pluginListLines()) }
    if (t === '0' || t === 'exit' || t === 'quit') return out(['考工记收工。这个黑窗口一关，服务就停了。'], { exit: true })
    return out([`没听懂「${text.trim()}」。只认这几个词：1 / 2 / 0`])
  }

  if (S.view === 'check') {
    if (t === '1') { const r = await health.scan(env); return out(['自动体检', '', ...r.lines, '', ...CHECK]) }
    if (t === '2') { const r = logs.list(env, 5); S.rows = r.rows; S.view = 'logs'; return out(['错误日志分析', '', ...r.lines]) }
    if (t === '0') { reset(); return out(MENU, { prompt: '考工记> ' }) }
    return out(['只认：1 自动体检 / 2 错误日志分析 / 0 返回'])
  }

  if (S.view === 'logs') {
    if (t === '0') { S.view = 'check'; return out(CHECK) }
    const n = Number(t)
    if (!Number.isInteger(n) || n < 1 || n > S.rows.length) return out([`只认 1-${S.rows.length} 之间的编号，或者 0 返回`])
    const r = logs.detail(env, S.rows[n - 1], EXPORT_DIR)
    return out([...r.lines, '', '（看完接着输入编号，或 0 返回）'])
  }

  if (S.view === 'plugin-list') {
    if (t === '0') { reset(); return out(MENU, { prompt: '考工记> ' }) }
    if (t === 'a') { const r = await plugins.scan(env); return out(['全体检测', '', ...r.lines, '', ...pluginListLines()]) }
    const n = Number(t)
    if (!Number.isInteger(n) || n < 1 || n > S.rows.length) return out([`只认 1-${S.rows.length} 的编号，a 全体检测，0 返回`])
    S.pick = n - 1; S.view = 'plugin-detail'
    return out(pluginDetailLines(S.rows[S.pick]))
  }

  if (S.view === 'plugin-detail') {
    const r = S.rows[S.pick]
    if (t === '0') { S.view = 'plugin-list'; return out(pluginListLines()) }
    if (t === 'd') {
      S.view = 'plugin-del'
      return out([
        `要删「${r.name}」的话，把插件名原样打一遍（一字不差）：`,
        `  ${r.name}`,
        '',
        '说明：目录会整个移进 考工记\\回收\\，配置里那条注册也会摘掉，配置本身先备份。',
        '      不是 rm，能撤回来。想反悔就随便输点别的。',
      ])
    }
    return out(['这个视图只认：d 删除 / 0 返回'])
  }

  if (S.view === 'plugin-del') {
    const r = S.rows[S.pick]
    if (text.trim() === r.name) {
      const res = plugins.removeOne(r, RECYCLE, stamp())
      S.rows = plugins.inventory(env)
      S.pick = 0; S.view = 'plugin-list'
      return out(['', ...res.lines, '', ...pluginListLines()])
    }
    S.view = 'plugin-detail'
    return out([`名字不对（要一字不差：${r.name}）。已取消，什么都没动。`, '', ...pluginDetailLines(r)])
  }

  reset()
  return out(MENU, { prompt: '考工记> ' })
}

/* ---------- HTTP：一个页面 + 两个接口（输出是纯文本行，人看是界面，复制出去就是给 AI 的料） ---------- */
const send = (res, code, type, body) => { res.writeHead(code, { 'content-type': type }); res.end(body) }

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
    // 页面文件被挪走时不把整个服务带走
    let page
    try { page = fs.readFileSync(path.join(DIR, 'web', 'index.html')) } catch { return send(res, 500, 'text/plain; charset=utf-8', 'web/index.html 读不到——文件被挪走或删了') }
    return send(res, 200, 'text/html; charset=utf-8', page)
  }
  if (req.method === 'GET' && req.url === '/api/boot') {
    return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ lines: bootLines, menu: MENU }))
  }
  if (req.method === 'POST' && req.url === '/api/in') {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', async () => {
      let text = ''
      try { text = JSON.parse(body || '{}').text || '' } catch { /* 坏包当空输入 */ }
      let payload
      try { payload = await handle(text) } catch (e) { payload = out([`考工记自己出错了：${e.message}`, '（这一条不影响被检测的 DSH）']) }
      send(res, 200, 'application/json; charset=utf-8', JSON.stringify(payload))
      if (payload.exit) setTimeout(() => process.exit(0), 300)
    })
    return
  }
  send(res, 404, 'text/plain; charset=utf-8', 'not found')
})

/* ---------- 自检：node server.mjs --selftest ---------- */
if (process.argv.includes('--selftest')) {
  let bad = 0
  const ck = (cond, msg) => { console.log((cond ? '  OK  ' : '  XX  ') + msg); if (!cond) bad++ }
  ck(fs.existsSync(env.home), `主目录在：${env.home}`)
  ck(env.profiles.length > 0, `profile ${env.profiles.length} 个：${env.profiles.map((p) => p.name).join('/')}`)
  const h = await health.scan(env)
  ck(h.lines.length > 0, `自动体检跑通（${h.ok} 过 / ${h.bad} 问题）`)
  const p = await plugins.scan(env)
  ck(p.lines.length > 0, `插件全体检测跑通（${p.ok} 过 / ${p.bad} 问题）`)
  const inv = plugins.inventory(env)
  ck(inv.length > 0, `插件清单跑通（${inv.length} 个）`)
  const l = logs.list(env, 5)
  ck(l.rows.length > 0, `日志列表跑通（报告 ${env.crashFiles.length} 份，列出 ${l.rows.length} 条）`)
  if (l.rows.length) {
    const d = logs.detail(env, l.rows[0], EXPORT_DIR)
    ck(fs.existsSync(d.out) && fs.statSync(d.out).size > 0, `分片 + 导出跑通：${path.basename(d.out)}`)
  }

  // 删除演练：在临时沙箱里造一份 patch + 假插件，真删一遍，不碰真配置
  const sand = path.join(os.tmpdir(), 'kgj-selftest-' + Date.now())
  const fake = path.join(sand, 'plugins', 'fake-plugin')
  fs.mkdirSync(path.join(fake, 'src'), { recursive: true })
  fs.writeFileSync(path.join(fake, 'package.json'), JSON.stringify({ name: 'fake', version: '1.0.0', type: 'module', main: 'src/index.ts', peerDependencies: { '@deepseek-ai/cordis': '*' } }))
  fs.writeFileSync(path.join(fake, 'src', 'index.ts'), 'export const name = "fake"\n')
  const patchFile = path.join(sand, 'cordis.patch.yml')
  fs.writeFileSync(patchFile, [
    '- id: keep-me', "  name: '@deepseek-ai/dsh-keep'", '  config:', '    enabled: true',
    '- insert:', '    - id: fake-plugin', `      name: '${path.join(fake, 'src', 'index.ts').replace(/\\/g, '/')}'`, '      config:', '        enabled: true', '',
  ].join('\n'))
  const proff = { name: 'demo', dir: sand, patchFile, pluginsDir: path.join(sand, 'plugins') }
  // 造一个"别处还有引用"的场面，验一下它会不会被点出来
  fs.writeFileSync(path.join(sand, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { 'fake-plugin': '*' } }))
  const inv2 = plugins.inventory({ profiles: [proff] })
  ck(inv2.length === 1 && inv2[0].integ.score === inv2[0].integ.total, `删除演练：假插件完整度 ${inv2[0]?.integ.score}/${inv2[0]?.integ.total}`)
  const del = plugins.removeOne(inv2[0], path.join(sand, '回收'), 'selftest')
  const after = plugins.readPatch(patchFile)
  ck(del.ok && !fs.existsSync(fake) && after.entries.length === 1 && after.entries[0].id === 'keep-me',
    '删除演练：注册摘掉、目录移进回收、别的条目没动')
  ck(del.lines.some((l) => l.includes('还提到这个插件名')), '删除演练：别处还有引用会被点出来')
  ck(del.lines.some((l) => l.includes('边界：插件自己写到别处')), '删除演练：报告里写明了不碰插件自己的数据')
  fs.rmSync(sand, { recursive: true, force: true })

  // 回归：栈顶定位必须认得出四种路径形态（审稿的人抓出来的盘符 bug，别再退化）
  const frames = [
    'at TLSSocket.<anonymous> (file:///C:/u/p/plugins/my-plugin/src/index.ts:109:85)',
    'at x (file:///D:/tools/resources/app.asar/lib/main.js:3724:64)',
    'at y (file:///home/u/app/packages/x/src/index.ts:12:7)',
    'at file:///dsh/plugins/foo/index.ts:9:1',
  ].map((s) => logs.topFrame(s))
  ck(frames.every((x) => x && /:\d+$/.test(x)), `栈顶定位四种路径都认得：${frames.join(' / ')}`)

  reset()
  const rBad = await handle('9')
  ck(/没听懂/.test(rBad.lines.join('')), '状态机：主菜单乱敲会被挡回来')
  const r1 = await handle('1')
  ck(r1.lines.some((x) => x.includes('自动体检')), '状态机：输入 1 进体检子菜单')
  const rBad2 = await handle('9')
  ck(/只认/.test(rBad2.lines.join('')), '状态机：子菜单乱敲会被挡回来')
  reset()
  const r2 = await handle('2')
  ck(r2.lines.some((x) => x.includes('插件清单')), '状态机：输入 2 进插件清单')
  const r3 = await handle('1')
  ck(r3.lines.some((x) => x.includes('完整度')), '状态机：编号进完整度明细')
  const rd = await handle('d')
  ck(rd.lines.some((x) => x.includes('打一遍')), '状态机：删除要先打插件名')
  const rc = await handle('随便输点别的')
  ck(rc.lines.some((x) => x.includes('已取消')), '状态机：名字不对就取消，什么都不动')
  reset()
  console.log(bad ? `\n${bad} 项没过` : '\n全过')
  process.exit(bad ? 1 : 0)
}

const listen = (port, tries = 0) => new Promise((resolve) => {
  server.once('error', (e) => { if (e.code === 'EADDRINUSE' && tries < 20) resolve(listen(port + 1, tries + 1)); else { console.error('起不来了：', e.message); process.exit(1) } })
  server.listen(port, '127.0.0.1', () => resolve(port))
})

const port = await listen(PORT0)
const url = `http://127.0.0.1:${port}/`
console.log('考工记已上线：' + url)
console.log('（这个窗口别关；关了服务就停。Ctrl+C 或直接关窗口都能退。）')
if (!process.argv.includes('--no-open')) {
  // spawn 起不来是异步 emit('error')，try/catch 抓不到；没监听器会直接崩掉整个进程
  const opener = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' })
  opener.on('error', () => console.log('浏览器没自动打开的话，把上面那个网址复制进浏览器。'))
  opener.unref()
}
