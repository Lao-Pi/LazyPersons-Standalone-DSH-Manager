/**
 * 考工记（kaogongji）· 插件薄壳
 * 版权所有 © 2026 小寻 · MIT License（见同目录 LICENSE）
 *
 * 这层壳只干三件事，一件都不多：
 *   1. 注册工具 kaogongji      —— 回答"本体在哪个路径、怎么跑、能查哪几样"（给别的 AI 的路标）
 *   2. 注册工具 kaogongji_open —— 起本体（独立进程 + 浏览器），不占用 DSH
 *   3. 装载时留一行"我活了"     —— 装载级验活的约定，没有这行就是插件欠设计
 *
 * 本体（考工记\server.mjs 那一套）完全独立：DSH 崩了、没开、这层壳被删了，它照样跑。
 * 反过来，这层壳依赖本体在不在——找不到就明说，不静默。
 *
 * 避死法（tools 第二十二节的五种静默不加载）：
 *   · 零相对 import——只用 node: 和 @deepseek-ai/，不 import 本体模块（用 spawn + 路径）
 *   · inject 里把要碰的服务都声明了（碰 ctx.tools 必须声明 tools）
 *   · config 里只放 schema 声明过的键
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const name = 'kaogongji'
export const inject = ['tools', 'systemPrompt']

export interface Config { enabled?: boolean }

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true).description('关掉的话壳不注册工具，本体照样能独立跑'),
})

// 本体跟着包走（就在这个插件目录里），不依赖工作区、不依赖任何相对路径解析
const HERE = path.dirname(fileURLToPath(import.meta.url))
const BODY_DIR = path.join(HERE, '考工记')
const SERVER = path.join(BODY_DIR, 'server.mjs')

// 起本体要用真的 node：DSH 宿主可能是 Electron 进程，process.execPath 未必是 node
const findNode = (): string => {
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
  const runtimes = path.join(home, 'dsh-runtimes')
  try {
    for (const r of fs.readdirSync(runtimes)) {
      for (const rel of [['dependencies', 'node', 'bin', 'node.exe'], ['dependencies', 'node', 'bin', 'node']]) {
        const p = path.join(runtimes, r, ...rel)
        if (fs.existsSync(p)) return p
      }
    }
  } catch { /* 没找到就往下退 */ }
  return process.execPath
}

export function apply (ctx: Context, cfg: Config) {
  const log = ctx.logger('kaogongji')
  const bodyThere = fs.existsSync(SERVER)
  // 装载自报：装完先翻日志看这一行
  log.info('考工记装载：本体=' + (bodyThere ? SERVER : '没找到（' + SERVER + '）') + '，工具=' + (cfg.enabled === false ? '关' : '开') + '，node=' + findNode())

  if (cfg.enabled === false) return

  // 装了就得让人知道本体在哪。工具描述每轮都在 AI 眼前——这是能做到的最"强制"的一层：
  // 只要它读过工具列表，就会看到这句话，也就没有理由不转告用户。
  const tellUser = `【装了就要转告用户】考工记的本体在这个路径：${BODY_DIR}（入口 ${SERVER}）。要体检、看崩溃报告、清插件，就去那儿双击 启动.bat——DSH 起不来的时候它照样能用。请把这句话原样告诉用户。`

  ctx.tools.register(defineTool({
    name: 'kaogongji',
    description: `${tellUser} 这个工具自己不跑扫描，只回答入口和用法；要起本体就用 kaogongji_open。`,
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          entry: { type: 'string', required: true },
          exists: { type: 'boolean', required: true },
          launch: { type: 'string', required: true },
          can: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute () {
      return {
        entry: SERVER,
        exists: fs.existsSync(SERVER),
        launch: `"${findNode()}" "${SERVER}"`,
        can: '自动体检（DSH 完整度 9 项）｜错误日志分析（最新 5 份崩溃报告，分片 + 官方文档网址 + 导出）｜插件管理（完整度 8 项 + 一键删除，删除走回收、不 rm）',
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'kaogongji_open',
    description: `${tellUser} 这个工具会真的把本体起起来：本地小服务 + 浏览器里的老式终端界面（127.0.0.1，端口从 19390 起自动挑）。独立进程，不占用 DSH，关掉那个黑窗口就停。`,
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { started: { type: 'boolean', required: true }, entry: { type: 'string', required: true }, node: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.started ? `考工记已起来（${value.node}）：${value.entry}` : `没起来：本体不在 ${value.entry}` }],
    },
    async execute () {
      if (!fs.existsSync(SERVER)) throw new Error('本体不在：' + SERVER + '——插件包不完整，或者被人删过')
      const node = findNode()
      const child = spawn(node, [SERVER], { detached: true, stdio: 'ignore' })
      child.on('error', () => { /* 起不来也不该把宿主带走 */ })
      child.unref()
      return { started: true, entry: SERVER, node }
    },
  }))
}
