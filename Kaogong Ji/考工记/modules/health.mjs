// 自动体检：DSH 整体完整度。只读——不写、不删、不读凭据文件。
import fs from 'node:fs'
import path from 'node:path'

export const title = '自动体检'

const OK = (s) => `[ OK ] ${s}`
const BAD = (s) => `[ !! ] ${s}`
const INFO = (s) => `[ -- ] ${s}`

export async function scan(env) {
  const lines = []
  let ok = 0, bad = 0
  const check = (pass, good, trouble) => { if (pass) { lines.push(OK(good)); ok++ } else { lines.push(BAD(trouble)); bad++ } }

  lines.push(`DSH 主目录   ${env.home}`)
  check(fs.existsSync(env.home), '主目录存在', '主目录找不到（没装过 DSH，或 DSH_HOME 指错了）')

  check(env.profiles.length > 0, `找到 profile：${env.profiles.map((p) => p.name).join(' / ')}`, 'profiles 目录下一个 profile 都没有')
  for (const p of env.profiles) {
    check(fs.existsSync(p.patchFile), `「${p.name}」有 cordis.patch.yml`, `「${p.name}」缺 cordis.patch.yml——配置层丢了，DSH 起不来`)
    check(fs.existsSync(p.pluginsDir), `「${p.name}」有 plugins 目录`, `「${p.name}」缺 plugins 目录`)
    const pkg = path.join(p.dir, 'package.json')
    check(fs.existsSync(pkg), `「${p.name}」有 package.json`, `「${p.name}」缺 package.json`)
  }

  check(env.runtimes.length > 0, `找到运行时 ${env.runtimes.length} 套（本进程 Node ${process.version}）：${env.runtimes[0] || ''}`, '没找到 dsh-runtimes——DSH 自带的 Node 丢了')

  check(fs.existsSync(env.sessionsDir), '会话存储目录在', '会话存储目录不在（新的还没建过）')

  lines.push('')
  lines.push('日志与报障')
  check(fs.existsSync(env.logsDir), `报障目录在   ${env.logsDir}`, `报障目录不在   ${env.logsDir}`)
  check(env.canWriteLogs, '报障目录可写（DSH 崩了才写得进下一份）', '报障目录不可写——下次崩溃可能留不下现场')
  lines.push(INFO(`里面现有 ${env.crashFiles.length} 份崩溃报告`))

  // 凭据文件只报存在，不读内容（考工记不碰它）
  const cred = path.join(env.home, '.credentials.yaml')
  if (fs.existsSync(cred)) lines.push(INFO('检测到 .credentials.yaml——只报存在，不读、不导出'))

  lines.push('')
  lines.push(bad === 0 ? `结论：${ok} 项全过，DSH 看着是完整的。` : `结论：${ok} 项过，${bad} 项有问题（上面带 [ !! ] 的）。`)
  return { lines, ok, bad }
}
