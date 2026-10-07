# MCP Console

TypeScript 版的 MCP 服务器控制台：**多接入点 × 多设备 × 多 MCP 服务器**，图形界面，可打包成单个 exe。

## 下载

Windows x64 预编译版，解压即用，无需 Node 环境：

| 文件 | 说明 |
| --- | --- |
| [MCP-Console-0.1.0-portable.exe](https://github.com/geek-alpha/mcp-console/releases/download/v0.1.0/MCP-Console-0.1.0-portable.exe) | 便携版，单文件双击运行，不写注册表 |
| [MCP-Console-0.1.0-x64.exe](https://github.com/geek-alpha/mcp-console/releases/download/v0.1.0/MCP-Console-0.1.0-x64.exe) | NSIS 安装版 |

全部版本见 [Releases](https://github.com/geek-alpha/mcp-console/releases)。从源码构建：`npm install && npm start`（开发模式），`npm run dist:portable`（打包）。


逻辑对齐 `D:\AI\wife_bot\mcp_pipe.py`：一条管道 = WebSocket（接入点）与一个 MCP 服务器子进程的 stdio 双向转发，断线按 1s → 2s → 5s 退避重连。

## 概念

| 概念 | 说明 | 对应 mcp_pipe.py |
| --- | --- | --- |
| 接入点 Endpoint | 一个 `ws://` / `wss://` 地址 | `MCP_ENDPOINT` |
| MCP 服务器 Server | stdio（本地进程）/ sse / http 三种传输 | `mcp_config.json` 里的 `mcpServers` 条目 |
| 设备 Device | 一个接入点 + 一个或多个 MCP 服务器 | 一次 `python mcp_pipe.py` 启动的全部管道 |
| 管道 Pipe | 设备 × 服务器，运行时的最小单位 | 每个 server 一条 `connect_with_retry` 任务 |

一台设备可以挂多个服务器：启动设备时，每挂一个服务器就起一条独立管道（各自的 WS 连接 + 各自子进程）。

## 功能

- 接入点增删改，支持 `Authorization: Bearer` 令牌、启停开关
- 设备增删改：绑定接入点、勾选任意多个 MCP 服务器、单设备自启开关
- 服务器增删改：stdio（command / args / cwd / env）、sse、http（url / headers）
- 一键导入 / 导出 `mcp_config.json`（与 `mcp_pipe.py`、其它 MCP 客户端共用同一份配置）
- **连通测试**：接入点测 WS 握手与延迟，服务器测完整 MCP 握手（initialize → tools/list）并列出工具名
- **工具自省**：服务器页与设备页都能展开工具清单，逐个工具看参数名、类型、必填、说明（读的就是服务器自己的 inputSchema）
- **调试台**：挑服务器 → 选工具 → 按 schema 生成表单 → 真调一次，原始 JSON 返回、耗时、stderr 全给
- **内置助手服务器**：一键载入 Codex / OpenCode / DSH 启停 + 大白交互（`codex_start` / `dsh_start` / `dabai_ask` 各一套）
- **端侧即时应答**：`<助手>_start` 与 `dabai_ask` 都是「起完就回话」——200 ms 内确认进程真起来了就返回「已开始」，起不来（可执行文件缺失 / 启动即崩）立刻返回失败。小智这类语音端不会卡在等回复上，大白的几分钟回答用 `dabai_result` 回头取
- **工具路径探测**：Codex / OpenCode / DSH / Python / Node / 大白目录自动定位（设置 → 环境变量 → PATH → 常见安装位置），探测结果写进内置服务器 env，换机器 / 换安装位置不用改脚本
- **可移植引用**：内置服务器的运行时与脚本在 config.json 里存成 `{node}` / `{servers}/codex.cjs` / `{tool:codex}`，启动时按当前程序位置现场解析——装到哪个盘、换台机器、便携版换临时目录都不用改配置；导出 mcp_config.json 时自动展开成真实路径
- **界面上看得见的解析结果**：服务器页每行直接显示「实际执行：<运行时> <脚本>」，搬了目录这行就跟着变；设置页列出全部引用 → 当前值。配置和说明文本里都不留安装路径快照（内置服务器一律压回引用，自定义服务器不动）
- **便携版稳定目录**：单文件 exe 每次运行都解压到 `%TEMP%\<随机>\`，助手脚本会释放到 exe 同级的 `mcp-console-data\servers`
- 运行时控制：单设备启动 / 停止 / 重启，全局启动 / 停止
- 实时日志：下行（接入点→服务器）、上行（服务器→接入点）、stderr、系统事件四类，可按设备 / 类型 / 关键词过滤
- 配置持久化在 `%APPDATA%\MCP Console\config.json`

## 连通测试

服务器页与接入点页每行都有测试按钮，结果直接标在行内，同时写进「日志」页：

| 对象 | 判定标准 | 失败时给出 |
| --- | --- | --- |
| 接入点 | WS 握手成功并保持 400 ms 不被对端踢掉 | 握手超时 / 连接被拒 / 被关闭的 code |
| MCP 服务器 | `initialize` 拿到 serverInfo → `tools/list` 拿到工具清单 | 缺 command、进程提前退出、握手超时、错误码，并附 stderr 末尾 8 行 |

测试起的是独立的一次性进程/连接，不影响正在运行的管道。

## 内置助手服务器

服务器页「载入内置」一键写入三个，把三个编程助手的启动与终止变成 MCP 工具：

| 名称 | 启动方式 | 工具 |
| --- | --- | --- |
| Codex 启停 | `servers/codex.cjs` → `codex exec <prompt>` | `codex_start` / `codex_stop` / `codex_status` / `codex_logs` |
| OpenCode 启停 | `servers/opencode.cjs` → `opencode run <prompt>`，无 prompt 则 `serve`（4096） | `opencode_start` / `opencode_stop` / `opencode_status` / `opencode_logs` |
| DSH 启停 | `servers/dsh.cjs` → `dsh --profile headless <prompt>`，无 prompt 则 `dsh web`（3080） | `dsh_start` / `dsh_stop` / `dsh_status` / `dsh_logs` |
| 大白 交互 | `servers/dabai.cjs` → `python dabai_cli.py <prompt>`（工作目录与解释器自动探测） | `dabai_ask` / `dabai_result` / `dabai_health` / `dabai_start` / `dabai_stop` / `dabai_status` / `dabai_logs` |

工具名带助手前缀：四套工具会一起出现在同一个接入点上，同名会互相覆盖，前缀保证每个助手一套、互不干扰（裸名 `start` 仍可调用，兼容手工测试）。

四个脚本都是零依赖 Node；运行时优先用系统 node（「设置 → 工具路径」里的 Node.js 运行时可以手填），找不到才退回 Electron 自带的 node（`ELECTRON_RUN_AS_NODE=1`）。安装版与开发态的脚本在包内、路径本来就稳定；便携版会释放到 exe 同级——见下面「便携版与路径稳定」。

| 工具 | 作用 |
| --- | --- |
| `<助手>_start` | 立刻回「已开始」（不等任务跑完），返回实例 id / pid / 日志路径；只有起不来才报错（`args` 覆盖默认参数，`cwd` / `label` 可选） |
| `<助手>_stop` | 终止进程（Windows `taskkill /T /F` 连子进程一起收），省略 id 则收全部在跑的 |
| `<助手>_status` | 看实例 pid / 存活 / 运行时长 / 端口是否在听 / 日志尾部 |
| `<助手>_logs` | 读某次运行的输出尾部 |
| `dabai_ask` | 让大白跑一轮：立刻回「已开始」和 jobId，不等它答完（填 `waitMs` 才当场等） |
| `dabai_result` | 取某轮大白的进展或结果：默认立刻返回（running / done + 已产出的回复），给 `waitMs` 才等到跑完 |
| `dabai_health` | 大白环境自检：python、`dabai_cli.py`、工作目录三项是否就位 |

## 工具路径

路径不写在脚本里：助手脚本按「环境变量 → PATH → 常见安装位置 → 兜底名」四级找可执行文件，控制台的「设置 → 工具路径」再补一层自动探测与手填覆盖。

| 优先级 | 来源 | 例子 |
| --- | --- | --- |
| 1 | 设置 → 工具路径 里手填 | `C:\Users\me\AppData\Roaming\npm\codex.cmd` |
| 2 | 环境变量 | `MCP_AGENT_CODEX_BIN` / `MCP_AGENT_DSH_HOME` / `MCP_AGENT_DABAI_PYTHON` / `MCP_AGENT_NODE` |
| 3 | PATH（Windows 按 PATHEXT 试 `.cmd` / `.exe`） | `codex` |
| 4 | 常见安装位置（`~`、`%APPDATA%` 展开，`*` 通配） | `%LOCALAPPDATA%\Programs\Python\Python3*\python.exe` |
| 5 | 兜底名（找不到也照常起，日志里给告警） | `python` |

「设置 → 工具路径」列出每个工具的状态（来源 + 版本）与查过的地方，可手填覆盖；点「写入内置服务器」把探测到的绝对路径写进内置服务器的 env（服务器页 → 编辑 → 环境变量里能看到、也能改）。只靠 PATH 找到的不写死，安装位置变了照样跑。

可用环境变量（手动跑脚本时也能用）：

| 工具 | 环境变量 |
| --- | --- |
| Node | `MCP_AGENT_NODE`（内置服务器的 JS 运行时） |
| Codex | `MCP_AGENT_CODEX_BIN`、`MCP_AGENT_CODEX_CWD` |
| OpenCode | `MCP_AGENT_OPENCODE_BIN`、`MCP_AGENT_OPENCODE_CWD`、`MCP_AGENT_OPENCODE_PORT` |
| DSH | `MCP_AGENT_DSH_BIN`、`MCP_AGENT_DSH_HOME`、`MCP_AGENT_DSH_PORT` |
| 大白 | `MCP_AGENT_DABAI_PYTHON`、`MCP_AGENT_DABAI_HOME`、`MCP_AGENT_DABAI_USER` |

进程状态与日志落在 `%LOCALAPPDATA%\mcp-console-agents\<助手>\`（POSIX 在 `~/.local/state/` 下），控制台重启后照样找得回、杀得掉。

## 便携版与路径稳定

`MCP-Console-<version>-portable.exe` 是自解压单文件：每次运行都把自己解到 `%TEMP%\<随机>\`，于是 `process.execPath` 与 `process.resourcesPath` 每次都不同——上次存进 config.json 的路径下次必然失效（典型现象：内置服务器全部起不来，手改也改不动，因为改的是会变的路径）。

处理办法：

| 环节 | 做法 |
| --- | --- |
| 脚本位置 | 启动时把包内 `resources\servers` 同步到 **exe 同级** 的 `mcp-console-data\servers`（大小/时间一致就跳过），exe 目录写不进去（写保护 U 盘 / Program Files）则退回 `%APPDATA%\MCP Console\servers` |
| 运行时 | 优先系统 node（跨运行稳定）；没有才用当前进程兜底 |
| 配置自愈 | 每次启动检查内置服务器：command 或脚本文件不存在 → 用当前有效值修回来；**手改过且有效的路径原样保留** |
| 手动触发 | 「设置 → 内置服务器与运行时」看当前形态 / 脚本目录 / 释放了几个文件，可一键「检查并修复路径」或打开脚本目录 |

安装版（nsis）与开发态包内路径本来就稳定，不做搬运；同样的自愈逻辑一样生效。

## 开发

```bash
npm install
npm run dev        # Vite 热更新 + Electron
```

## 构建与打包

```bash
npm run build            # 编译主进程 + 打包前端到 dist/
npm run dist:portable    # 产出 release/MCP-Console-<version>-portable.exe（免安装单文件）
npm run dist             # portable + nsis 安装包
```

国内网络建议先设镜像（`.npmrc` 里已配好）：

```
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
```

## 自检

```bash
node scripts/smoke-pipe.mjs     # 管道层：mock 接入点 + mock MCP 服务器，验证双向转发与断线重连（7 项）
node scripts/smoke-e2e.mjs      # 全链路：写临时配置 → 起真实 Electron → startAll + 连通测试 + 工具自省 + 调试台调用 + 工具路径探测 + UI 点击与弹窗输入（34 项）
node scripts/smoke-resolve.mjs  # 工具路径解析：env → PATH → 常见位置 → 兜底 四级回退与告警（7 项）
node scripts/smoke-builtins.mjs # 助手服务器：三个服务器真 MCP 握手（工具名不重复）+ start/stop/logs 链路（13 项）
node scripts/smoke-dabai.mjs    # 大白服务器：握手 + 6 个工具齐全 + dabai_health 环境自检（5 项；加 MCP_CONSOLE_SMOKE_ASK=1 再真问一轮）
node scripts/smoke-portable.mjs # 便携版稳定性：跑三次真实 portable exe，验证脚本释放到稳定目录、失效路径自愈、手改不被覆盖、删了会重放（14 项）
scripts\smoke-exe.bat           # 同上，但跑打包后的 release\MCP-Console-*-portable.exe
npx electron scripts/probe-device-input.mjs   # 弹窗输入探针：真实鼠标点击 + 真实按键，看焦点落在哪、字有没有进去
npx electron scripts/probe.js   # 渲染自检：加载 dist/renderer 并打印 DOM 检查结果（写到 probe.txt）
```

`MCP_CONSOLE_SMOKE=<报告文件>` 让主进程渲染完成后写一份自检报告再退出；
再加 `MCP_CONSOLE_SMOKE_FLOW=1` 会顺带 `startAll()` 并抓运行时状态与界面状态。
`MCP_CONSOLE_TRACE=<文件>` 记录启动关键节点（Windows GUI 进程拿不到 stdout，只能落文件）。

## 目录

```
src/shared/types.ts     主进程 / 渲染进程共用的类型与 IPC 契约
src/main/store.ts       配置读写、mcp_config.json 导入导出
src/main/spawn.ts       服务器启动命令解析（stdio 直起；sse/http 走 mcp_proxy）
src/main/pipe.ts        PipeRunner：单条管道的连接、转发、重连
src/main/tester.ts      服务器通道：连通测试、工具自省（tools/list + schema）、工具调用（tools/call）
src/main/builtins.ts    内置助手服务器定义；便携版脚本释放到稳定目录、运行时选择、启动时路径自愈
src/main/toolchain.ts   工具链探测：设置 / env / PATH / 常见安装位置 + 版本（Node / Codex / OpenCode / DSH / Python / 大白 / DSH 仓库）
src/main/manager.ts     PipeManager：设备 ↔ 管道编排、日志环形缓冲
src/main/index.ts       主进程入口：窗口、IPC、生命周期
src/preload/index.ts    contextBridge 暴露 window.mcpConsole
src/renderer/           React 界面（概览 / 设备 / 接入点 / 服务器 / 调试台 / 日志 / 设置）
src/renderer/components/ToolList.tsx  工具清单 + 参数表（服务器页 / 设备页共用）
src/renderer/pages/Debug.tsx          调试台：选工具、按 schema 填参、真调一次
servers/                零依赖助手 MCP 服务器：Codex / OpenCode / DSH 启停 + 大白交互（打包进 resources/servers）
scripts/                开发、自检与 mock 脚本
```
