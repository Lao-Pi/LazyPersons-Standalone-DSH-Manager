// 插件检测 · 完整度 · 一键删除。
// 检测只读；删除走「回收」——先备份配置和目录，再移走，最后当场复检。不做 rm。
import fs from 'node:fs'
import path from 'node:path'

export const title = '插件检测'

const OK = (s) => `[ OK ] ${s}`
const BAD = (s) => `[ !! ] ${s}`
const INFO = (s) => `[ -- ] ${s}`
const EXT_OK = /\.(js|ts|mjs|cjs|json|node)$/
const norm = (s) => s.replace(/\\/g, '/')

/* ---------- patch 行扫描：只认 id / name / insert 三样，够用，也不怕复杂写法 ---------- */
export function readPatch(patchFile) {
  const lines = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8').split('\n') : []
  const items = []
  lines.forEach((ln, n) => {
    const m = /^(\s*)-\s*(.*)$/.exec(ln)
    if (m) items.push({ n, indent: m[1].length, text: m[2].trim() })
    else {
      const nm = /^(\s*)name:\s*['"]?(.+?)['"]?\s*$/.exec(ln)
      if (nm && items.length) items[items.length - 1].nameLine = { n, indent: nm[1].length, value: nm[2] }
    }
  })
  const entries = []
  items.forEach((it, i) => {
    const idm = /^id:\s*['"]?([^'"\s]+)['"]?$/.exec(it.text)
    if (!idm) return
    let end = lines.length
    let parent = null
    for (let j = i + 1; j < items.length; j++) if (items[j].indent <= it.indent) { end = items[j].n; break }
    for (let j = i - 1; j >= 0; j--) if (items[j].indent < it.indent) { parent = items[j]; break }
    // name 必须比 id 深两格，否则那是 config 里的同名字段
    const name = it.nameLine && it.nameLine.indent === it.indent + 2 ? it.nameLine.value : null
    entries.push({ id: idm[1], line: it.n, indent: it.indent, name, parent, start: it.n, end })
  })
  return { lines, entries }
}

// 三类"会让整份 YAML 解析失败"的写法
export function checkPatchSyntax(lines) {
  const bad = []
  lines.forEach((ln, n) => {
    if (ln.includes('\t')) bad.push(`${n + 1} 行有 Tab（YAML 禁用）`)
    else if (/^\s*-\S/.test(ln)) bad.push(`${n + 1} 行的 "-" 后面缺空格`)
    else if (/^[^#\s][^:]*:[^\s]/.test(ln)) bad.push(`${n + 1} 行冒号后缺空格`)
  })
  return bad
}

const pluginDirs = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name) } catch { return [] } }

// 源码级：相对 import 漏扩展名（四死法第 4 条，插件会静默死）
function sourceIssues(dir) {
  const files = []
  const walk = (d, depth) => {
    if (depth > 4) return
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (/^(node_modules|vendor|\.git|dist)$/.test(e.name)) continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (/\.(ts|js|mjs|cjs)$/.test(e.name)) files.push(p)
    }
  }
  try { walk(dir, 0) } catch { /* 读不动就跳过 */ }
  const imports = []
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8')
    for (const m of s.matchAll(/from\s+['"](\.[^'"]*)['"]/g)) if (!EXT_OK.test(m[1])) imports.push(`${path.basename(f)} 里 "${m[1]}"`)
  }
  return { imports }
}

/* ---------- 单个插件的完整度：判据照四个能加载的插件定 ---------- */
export function integrity(dir, entry) {
  const checks = []
  const add = (item, pass, note) => checks.push({ item, pass, note: note || '' })
  const pkgFile = path.join(dir, 'package.json')
  const hasPkg = fs.existsSync(pkgFile)
  let pkg = {}
  if (hasPkg) { try { pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')) } catch { pkg = {} } }
  const mainFile = pkg.main ? path.join(dir, pkg.main) : null
  const peers = pkg.peerDependencies ? Object.keys(pkg.peerDependencies) : []
  const src = sourceIssues(dir)
  add('package.json 在', hasPkg, hasPkg ? '' : '缺了 DSH 不认这个插件')
  add('有 name', !!pkg.name, pkg.name || '')
  add('有 version', !!pkg.version, pkg.version || '')
  add('type: module', pkg.type === 'module', pkg.type || '缺（ESM 插件要 "type": "module"）')
  add('main 的入口文件在', !!mainFile && fs.existsSync(mainFile), pkg.main ? (fs.existsSync(mainFile) ? pkg.main : `${pkg.main} 找不到`) : '缺 main，DSH 不知道从哪加载')
  add('有 peerDependencies', peers.length > 0, peers.length ? peers.join(' ') : '缺，宿主 API 版本没声明')
  add('patch 里有注册', !!entry, entry ? `id=${entry.id}` : '有目录没注册——丢进去不等于装上')
  add('相对 import 都带扩展名', src.imports.length === 0, src.imports.slice(0, 2).join('；'))
  return { checks, pkg, src, score: checks.filter((c) => c.pass).length, total: checks.length }
}

/* ---------- 清单：所有 profile 下所有插件目录 + 完整度 ---------- */
export function inventory(env) {
  const rows = []
  for (const prof of env.profiles) {
    const { entries } = readPatch(prof.patchFile)
    for (const name of pluginDirs(prof.pluginsDir)) {
      const dir = path.join(prof.pluginsDir, name)
      const entry = entries.find((e) => e.name && norm(e.name).includes(`/plugins/${name}/`)) || null
      rows.push({ prof, name, dir, entry, integ: integrity(dir, entry) })
    }
  }
  return rows
}

/* ---------- 一键删除：备份 → 摘注册 → 移目录 → 复检 ---------- */
export function removeOne(row, recycleRoot, stamp) {
  const lines = []
  const dest = path.join(recycleRoot, stamp)
  fs.mkdirSync(path.join(dest, 'plugins'), { recursive: true })

  // 1. 配置先备份（哪怕最后没删成，也留个原件）
  const patch = row.prof.patchFile
  if (fs.existsSync(patch)) {
    fs.copyFileSync(patch, path.join(dest, 'cordis.patch.yml'))
    lines.push(`· 配置已备份 → ${path.join(dest, 'cordis.patch.yml')}`)
  }

  // 2. 从 patch 里摘掉这条注册；insert 块里只有它一个，就连 insert 行一起摘
  const pre = row.entry ? readPatch(patch) : null
  const before = pre ? pre.entries.map((e) => e.id) : []
  const target = row.entry?.id || null
  if (pre) {
    const { lines: raw, entries } = pre
    const siblings = entries.filter((e) => e.parent && row.entry.parent && e.parent.n === row.entry.parent.n).length
    const start = row.entry.parent && siblings <= 1 ? row.entry.parent.n : row.entry.start
    const baseIndent = row.entry.parent && start === row.entry.parent.n ? row.entry.parent.indent : row.entry.indent
    // 段里混进"顶层或同级的非列表内容"（散字段、--- 分隔符）说明范围框歪了。
    // 宁可拒绝也不静默吞掉——复检只对账 id 集合，非 id 的东西丢了是查不出来的（审稿的人点出来的）。
    const aliens = raw.slice(start, row.entry.end).map((l, i) => [l, start + i + 1])
      .filter(([l]) => l.trim() && !/^\s*-\s/.test(l) && l.match(/^\s*/)[0].length <= baseIndent)
    if (aliens.length) {
      lines.push(`！！ 要摘的这段里混着 ${aliens.length} 行认不出的内容（第 ${aliens[0][1]} 行：${aliens[0][0].trim().slice(0, 40)}）`)
      lines.push('   不自动摘了——配置和插件目录我都没动，这段得手工改。')
      return { lines, ok: false }
    }
    if (raw.slice(start, row.entry.end).some((l) => l.trim())) {
      raw.splice(start, row.entry.end - start)
      fs.writeFileSync(patch, raw.join('\n'), 'utf8')
      lines.push(`· 摘掉注册 id=${row.entry.id}（原第 ${start + 1}–${row.entry.end} 行）`)
    } else lines.push('· 那几行是空的，配置没动')
  } else {
    lines.push('· patch 里本来就没注册，跳过改配置')
  }

  // 3. 目录移进回收（不是删）
  const dest2 = path.join(dest, 'plugins', row.name)
  try { fs.renameSync(row.dir, dest2) } catch (e) {
    lines.push(`！！ 目录移不动（${e.code || e.message}）——配置已经摘了，但目录还在原处，手工处理`)
    return { lines, ok: false }
  }
  lines.push(`· 插件目录已移进回收 → ${dest2}`)

  // 4. 复检三件事：目标没了 / 别的条目一条没动 / 写法没坏
  //    只查"目标没了"是不够的——行范围算错会把别人的注册一起带走，所以拿删前删后的 id 集合对账
  const after = readPatch(patch)
  const afterIds = after.entries.map((e) => e.id)
  const expect = before.filter((id) => id !== target)
  const othersKept = expect.every((id) => afterIds.includes(id))
  const gone = !afterIds.includes(target)
  const syn = checkPatchSyntax(after.lines)
  const left = after.lines.filter((l) => /^\s*-\s/.test(l)).length
  // "完整删除"的边界：目录和注册摘了，但 profile 别处可能还有引用——查出来说清楚，别假装干净
  const refs = []
  for (const f of ['package.json', 'cordis.yml', 'pnpm-workspace.yaml']) {
    const p2 = path.join(row.prof.dir, f)
    if (fs.existsSync(p2) && fs.readFileSync(p2, 'utf8').includes(row.name)) refs.push(f)
  }
  if (after.lines.some((l) => l.includes(row.name))) refs.push('cordis.patch.yml 里还有别处提到它')
  if (gone && othersKept && syn.length === 0) lines.push(`· 复检：配置能读，注册已摘掉，别的 ${expect.length} 条一条没动，还剩 ${left} 条列表项`)
  else lines.push(`· 复检有问题：${gone ? '' : '注册还在；'}${othersKept ? '' : '别的条目被动了！'}${syn.join('；')}`)
  if (left === 0) lines.push('！！ 配置里一条列表项都不剩了，DSH 可能起不来——回收里那份备份覆盖回去就能救')
  if (refs.length) lines.push(`· 提醒：${refs.join('、')} 里还提到这个插件名——那些引用我没动，自己看一眼`)
  lines.push('· 边界：插件自己写到别处去的数据（日志、缓存），考工记不知道也不动')
  lines.push('')
  lines.push(`要撤回来：把 ${dest2} 移回 ${row.dir}，再用 ${path.join(dest, 'cordis.patch.yml')} 覆盖回 ${patch}`)
  lines.push('注意：DSH 正开着的话，配置一变它会立刻重载；保险做法是先关掉 DSH 再删。')
  return { lines, ok: gone && othersKept && syn.length === 0 }
}

/* ---------- 全局检测（主菜单里那项） ---------- */
export async function scan(env) {
  const lines = []
  let ok = 0, bad = 0

  for (const prof of env.profiles) {
    lines.push(`profile「${prof.name}」`)
    const patch = readPatch(prof.patchFile)
    const { entries } = patch
    const local = entries.filter((e) => e.name && /[\\/]/.test(e.name) && !e.name.startsWith('@'))
    lines.push(INFO(`patch 注册 ${entries.length} 条，其中本地插件 ${local.length} 条`))

    for (const e of local) {
      const file = norm(e.name.replace(/^file:\/\//, '')).replace(/^['"]|['"]$/g, '')
      if (fs.existsSync(file)) { lines.push(OK(`「${e.id}」文件在`)); ok++ } else { lines.push(BAD(`「${e.id}」注册了但文件不在：${file}`)); bad++ }
    }

    const dirs = pluginDirs(prof.pluginsDir)
    const orphan = dirs.filter((d) => !local.some((e) => norm(e.name).includes(`/${d}/`)))
    if (orphan.length) { lines.push(BAD(`有目录没注册（丢进去不等于装上）：${orphan.join(' / ')}`)); bad++ } else if (dirs.length) { lines.push(OK(`${dirs.length} 个插件目录都注册了`)); ok++ }

    for (const p of inventory({ profiles: [prof] })) {
      const miss = p.integ.checks.filter((c) => !c.pass)
      if (miss.length) { lines.push(BAD(`「${p.name}」完整度 ${p.integ.score}/${p.integ.total}：${miss.map((m) => m.item).join('、')}`)); bad++ } else { lines.push(OK(`「${p.name}」完整度 ${p.integ.score}/${p.integ.total}`)); ok++ }
    }

    const syn = checkPatchSyntax(patch.lines)
    if (syn.length) { syn.forEach((s) => lines.push(BAD(`patch 写法：${s}`))); bad += syn.length } else { lines.push(OK('patch 没有"冒号空格 / 列表项空格 / Tab"这三类致命写法')); ok++ }
    lines.push('')
  }

  lines.push(bad === 0 ? `结论：${ok} 项全过。` : `结论：${ok} 项过，${bad} 项有问题（带 [ !! ] 的）。`)
  return { lines, ok, bad }
}
