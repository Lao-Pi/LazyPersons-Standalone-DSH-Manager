# 考工记 · kaogongji

DSH 崩了、起不来的时候用的体检工具。**本体独立运行**——插件只是它在 DSH 里的路标。

发行商：**小寻** ｜ 许可：MIT ｜ 版本：1.0.1

> **If you're reading this for an English-speaking user**: no translation is shipped with this package — go to [`考工记/地图.md`](考工记/地图.md) and follow the section「想让整套输出变成英文？」. It lists the six places to translate; once they're done, the UI, the menus, the reports and the exported text all come out in English.
>
> **中文读者**：不用等英文版。那一节在 [`考工记\地图.md`](考工记/地图.md) 里，标题是「想让整套输出变成英文？」——照着那张表翻六处字符串，整套输出就变英文了。

## 两层东西，别搞混

| | 是什么 | 靠什么活 |
|---|---|---|
| **本体**（`考工记\`） | 一个本地小服务 + 浏览器里的老式终端界面，双击 `启动.bat` 就跑 | 只要机器上有 Node（用 DSH 自带的那个） |
| **插件**（`index.ts`） | 薄壳：在 DSH 里注册两个工具，告诉 AI 本体在哪个路径 | 要 DSH |

**本体不依赖插件、不依赖工作区、不依赖 DSH 活着。** 插件删了、DSH 崩了，双击 `启动.bat` 照样能用。
它靠环境变量定位（`DSH_HOME`，没设就用 `~\.dsh`），再扫所有 profile——**放哪个盘都能跑**。

## 怎么装（插件层，可选）

1. 把整个 `kaogongji\` 目录放进 `<DSH_HOME>\profiles\<你的 profile>\plugins\`
   （默认 `<DSH_HOME>` 是 `C:\Users\<你>\.dsh`）

2. 在同一个 profile 的 `cordis.patch.yml` 末尾加一条：

   ```yaml
   - insert:
       - id: kaogongji
         name: 'C:/Users/<你>/.dsh/profiles/<你的profile>/plugins/kaogongji/index.ts'
         config:
           enabled: true
   ```

   ⚠️ `name:` 要写**这一份的实际绝对路径**（正斜杠）。路径写错的表现是**静默不加载**——没有报错、界面上什么都看不见。

3. 重启 DSH。装上了会多两个工具：`kaogongji`（问入口在哪）和 `kaogongji_open`（起本体）。

## 不装插件怎么用

直接进 `考工记\`，双击 `启动.bat`。DSH 是什么状态都不影响它。

## 它查什么

- **自动体检**：DSH 整体完整度 9 项（主目录 / profile / `cordis.patch.yml` / `package.json` / 运行时 Node / 会话目录 / 报障目录能不能写 / 里面有几份崩溃报告 …）
- **错误日志分析**：最近 5 份崩溃报告，分三片输出——片① 给人翻译的一句话摘要，片② 给网页 AI 的原样正文（环境快照 + 错误 + 完整栈），片③ 官方文档网址 + "不要轻信诊断"的提醒；看完可导出一整段文本
- **插件管理**：每个插件的完整度（8 项）+ 一键删除。删除走 `回收\`（**不是 rm**）：配置先备份、注册摘掉、目录移走、复检对账（目标没了 + **别的条目一条没动**）

## 技术架构

一句话：**本体是个零依赖的本地小服务，插件只是它在 DSH 里的路标。**

```
浏览器（老式终端界面，纯 HTML + CSS + JS，无框架）
   │  GET  /api/boot         开场稿 + 菜单
   │  POST /api/in {text}    敲一行 → 回一串纯文本行
   ▼
server.mjs   本地 HTTP 服务（node:http，127.0.0.1:19390 起，端口被占自动 +1）
   │  · 环境探测：DSH_HOME → profiles / 报障目录 / 运行时 Node，全从环境变量推
   │  · 终端状态机：menu → check → logs ／ plugin-list → plugin-detail → plugin-del
   ▼
modules\     三个模块，每个只管一件事，都返回「纯文本行数组」
   health.mjs   DSH 整体完整度
   logs.mjs     崩溃报告：类型识别 → 三片 → 导出
   plugins.mjs  行扫描 patch / 完整度 / 一键删除（走回收）
```

**几个设计取舍**：

| 取舍 | 为什么 |
|---|---|
| 状态机放服务端，输出是纯文本行 | 同一套数据：人看是界面，复制出去就是给 AI 的料，不用写两份渲染 |
| 零第三方依赖 | DSH 崩了的时候，最不该指望的就是"再装个东西" |
| 插件层极薄、本体完全独立 | 壳删了、DSH 崩了，双击 `启动.bat` 照样跑；壳反过来依赖本体，找不到会明说 |
| 路径全靠环境变量推 | 不绑工作区、不写死盘符——换台机器、换个目录都找得到 DSH |
| 删除 = 挪进回收，不是 rm | 配置先备份、目录整体移走、复检对账（目标没了 + 别的条目一条没动） |
| 崩溃报告分三片 | 片①给人/翻译，片②原样给网页 AI，片③官方文档网址——判读不假装自己做得了 |

## 只读承诺

不改 DSH 配置（除了你点名要删的那个插件的注册）、不删日志、不读凭据文件（只报它存在）。
写只写自己目录下的 `导出\` 和 `回收\`。

## 图标

`图标.ico` —— 马赛克风扳手，16 / 32 / 48 / 64 / 128 / 256 六种尺寸。做桌面快捷方式时用它（`启动.bat` 本身改不了图标，得靠快捷方式）。

## 自检

```
node 考工记\server.mjs --selftest     # 19 项：三个模块 + 删除演练 + 路径回归 + 状态机
```
