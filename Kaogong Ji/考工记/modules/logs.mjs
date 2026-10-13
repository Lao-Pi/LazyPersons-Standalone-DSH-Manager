// 错误日志分析：最新 5 份崩溃报告 → 分片展示 → 导出成一段可直接发给网页 AI 的文本。
// 只读崩溃报告；唯一写的地方是「导出」目录。
import fs from 'node:fs'
import path from 'node:path'

export const title = '错误日志分析'

// 类型识别顺序：未捕获异常最具体，其次前端未激活，最后才是宿主退出码。
const TYPE_RULES = [
  [/fatal uncaught exception:\s*([A-Za-z_$][\w$]*)/, (m) => `未捕获异常 · ${m[1]}`],
  [/web boot:\s*(\d+) entries did not activate/, (m) => `前端未激活 · ${m[1]} 个条目`],
  [/host exited with (\d+)/, (m) => `宿主进程退出 · 退出码 ${m[1]}`],
]

// 已知案例：全是真踩过的坑，没踩过的不往里编。
const CASES = [
  [/this\.opts\.log is not a function/, '插件把 ctx.logger() 返回的 Logger 对象直接当函数传了。要包一层 (...a) => log.info(...a)（v2.1.1 验过的修法）。'],
  [/entries did not activate/, '前端有一批 client 模块没加载成功。看第一个失败的 bundle，别被后面一长串"跟着跳过"的条目带走。'],
  [/SEC_E_NO_CREDENTIALS/, '沙箱里 curl / Invoke-WebRequest 拿不到 TLS 凭证；抓网页改用 Python 的 urllib。'],
  [/DEP0180/, 'Node 弃用警告，不是崩溃原因——噪音，别顺着它查。'],
]

// 官方文档（10-08 抓存，10-13 实测 4 条 HTTP 200）；按报告里的 source 动态给。
const DOCS = {
  common: ['https://deepseek-harness.github.io/deepseek-harness/reference/config-catalog.md'],
  host: [
    'https://deepseek-harness.github.io/deepseek-harness/develop/basic/config.md',
    'https://deepseek-harness.github.io/deepseek-harness/develop/cordis-tutorial/06-composition-and-hmr.md',
    'https://deepseek-harness.github.io/deepseek-harness/develop/cordis-tutorial/03-services.md',
    'https://deepseek-harness.github.io/deepseek-harness/reference/cordis-api/fiber.md',
  ],
  'web-boot': [
    'https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/client-modules.md',
    'https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/web-client.md',
  ],
}
const REPO = 'https://github.com/deepseek-ai/deepseek-harness/tree/master/packages'

const pad = (n) => String(n).padStart(2, '0')
const localTime = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`

// 文件名里是 UTC（crash-2026-10-12T05-17-37-369Z-host.log），显示一律换算成本地时间。
const timeFromName = (f) => {
  const m = /^crash-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(f)
  return m ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`) : null
}

// limitBytes：列表阶段只读前 4 KB（头 9 个字段和 error 段开头都在里面）；详情阶段才读全文。
const parse = (file, limitBytes = Infinity) => {
  const fd = fs.openSync(file, 'r')
  const size = Math.min(fs.fstatSync(fd).size, limitBytes)
  const buf = Buffer.alloc(size)
  fs.readSync(fd, buf, 0, size, 0)
  fs.closeSync(fd)
  const lines = buf.toString('utf8').split('\n')
  const head = {}
  for (const ln of lines) {
    if (ln.startsWith('--- ')) break
    const m = /^([a-z][\w ]*):\s*(.*)$/.exec(ln)
    if (m) head[m[1]] = m[2].trim()
  }
  const i = lines.findIndex((l) => l.startsWith('--- error ---'))
  const j = lines.findIndex((l, n) => n > i && l.startsWith('--- '))
  return {
    head,
    truncated: size < fs.statSync(file).size,
    errBody: (i === -1 ? '' : lines.slice(i + 1, j === -1 ? undefined : j).join('\n')).trim(),
    tail: j === -1 ? '' : lines.slice(j).join('\n').trim(),
  }
}

const classify = (errBody) => {
  for (const [re, fmt] of TYPE_RULES) { const m = re.exec(errBody); if (m) return fmt(m) }
  return '未归类'
}

// 栈顶那行最值钱：能直接指出是哪个插件的哪一行。
// 盘符那个冒号必须放行——file:///C:/... 会被 [^):] 卡在 "C" 后面，Windows 上这行就永远是空的（审稿的人抓出来的）。
export const topFrame = (errBody) => {
  const m = /at\s+.*?\(?(file:\/\/\/(?:[A-Za-z]:)?[^):]+):(\d+):(\d+)\)?/.exec(errBody)
  if (!m) return null
  const p = decodeURIComponent(m[1].replace('file:///', ''))
  const plug = /[\\/]plugins[\\/]([^\\/]+)[\\/]/.exec(p)
  return plug ? `插件 ${plug[1]} → ${path.basename(p)}:${m[2]}` : `${path.basename(p)}:${m[2]}`
}

// 列表：最新的 n 份，按时间倒序（时间取文件名里的 UTC，不取 mtime）。
export function list(env, n = 5) {
  const files = fs.existsSync(env.logsDir) ? fs.readdirSync(env.logsDir).filter((f) => f.startsWith('crash-')) : []
  const all = files.map((f) => {
    const p = path.join(env.logsDir, f)
    const rep = parse(p, 4096)
    return { file: f, path: p, size: fs.statSync(p).size, time: timeFromName(f), head: rep.head, kind: classify(rep.errBody), where: topFrame(rep.errBody) }
  }).sort((a, b) => (b.time?.getTime() || 0) - (a.time?.getTime() || 0))

  const count = {}
  for (const r of all) count[r.kind] = (count[r.kind] || 0) + 1

  const rows = all.slice(0, n)
  const lines = [`报障目录   ${env.logsDir}`, `共 ${all.length} 份报告，下面是最近 ${rows.length} 份：`, '']
  rows.forEach((r, i) => {
    lines.push(`[${i + 1}] ${r.time ? localTime(r.time) : '时间未记录'}  ${(r.size / 1024).toFixed(1)} KB  ${r.kind}`)
    lines.push(`      source=${r.head.source || '?'} phase=${r.head.phase || '?'}${r.where ? '   ' + r.where : ''}`)
  })
  const dup = Object.entries(count).filter(([, n]) => n > 1).map(([k, n]) => `${k} ×${n}`)
  if (dup.length) lines.push('', `同一类反复出现：${dup.join('；')}`)
  lines.push('', '输入编号看详细分析（分片 + 导出），输入 0 返回。')
  return { rows, lines }
}

// 详情：三片 + 导出。片① 给人/翻译，片② 原样给网页 AI，片③ 是文档锚点（防止 AI 瞎编）。
export function detail(env, row, exportDir) {
  const rep = parse(row.path)
  const lines = []
  const firstLines = rep.errBody.split('\n').slice(0, 3).map((s) => s.trim()).filter(Boolean)

  lines.push('── 片① 一句话摘要（这行可以丢给翻译软件）──')
  lines.push(`${row.kind} ｜ ${firstLines[1] || firstLines[0] || '(空)'}`.slice(0, 200))
  lines.push('')
  lines.push('── 片② 原样正文（丢给网页端 AI 时，一个字符都别改）──')
  const body = [`time: ${rep.head.time || '?'}`, `source: ${rep.head.source || '?'}`, `phase: ${rep.head.phase || '?'}`,
    ...['app', 'platform', 'electron', 'node', 'locale'].map((k) => (rep.head[k] ? `${k}: ${rep.head[k]}` : '')).filter(Boolean), '', '--- error ---', rep.errBody]
  const shown = body.join('\n').split('\n')
  lines.push(...shown.slice(0, 28))
  if (shown.length > 28) lines.push(`...（还有 ${shown.length - 28} 行，全文在导出的文件里）`)
  lines.push('')
  lines.push('── 片③ 官方文档网址（和片②一起复制，让 AI 开联网照着找）──')
  for (const u of [...DOCS.common, ...(DOCS[rep.head.source] || [])]) lines.push(u)
  lines.push(REPO)
  lines.push('提示：原样粘贴、别发翻译版（插件名/路径/行号是关键词，翻译会翻坏）；')
  lines.push('      版本号务必带上（片②头部那几行）——DSH 是 pre-stable，文档和版本会错位；')
  lines.push('      网页端 AI 的诊断不要轻信，只信它指到文档哪一段。')

  const hits = CASES.filter(([re]) => re.test(rep.errBody)).map(([, text]) => text)
  if (hits.length) {
    lines.push('')
    lines.push('── 本地已知案例（这台机器上踩过的）──')
    hits.forEach((h) => lines.push('· ' + h))
  }

  fs.mkdirSync(exportDir, { recursive: true })
  const out = path.join(exportDir, row.file.replace(/^crash-/, '').replace(/\.log$/, '') + '.txt')
  fs.writeFileSync(out, [
    `# 崩溃报告导出：${row.file}`,
    `# 本地时间 ${row.time ? localTime(row.time) : '未记录'} ｜ ${row.kind}`,
    '', '--- 片② 原样正文 ---', body.join('\n'), '',
    '--- 片③ 官方文档网址（请开联网模式对照查找；不要轻信诊断，以你机器上的版本为准）---',
    ...[...DOCS.common, ...(DOCS[rep.head.source] || [])], REPO,
  ].join('\n'), 'utf8')
  lines.push('')
  lines.push(`已导出（用记事本打开、全选复制）：${out}`)
  return { lines, out }
}
