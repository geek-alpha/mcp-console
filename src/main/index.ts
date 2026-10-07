import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { ConfigStore, normalizeServer, uid } from './store'
import { PipeManager } from './manager'
import { callServerTool, listServerTools, testEndpoint, testServer } from './tester'
import { builtinEnvPatch, builtinServers, builtinsDir, ensureBuiltins, isBuiltinServer, repairBuiltinServers } from './builtins'
import { expandServer, expandServers, invalidateRefs, resolveTable } from './refs'
import { detectToolchain } from './toolchain'
import type { AppConfig, BuiltinsInfo, LogLine, ResolvedServer, ServerCallRequest } from '../shared/types'

const isDev = Boolean(process.env.MCP_CONSOLE_DEV_URL)

// 排查用：设 MCP_CONSOLE_TRACE=<文件> 时把启动关键节点写进去（GUI 进程在 Windows 拿不到 stdout）
const traceFile = process.env.MCP_CONSOLE_TRACE
const trace = (msg: string): void => {
  if (!traceFile) return
  try {
    appendFileSync(traceFile, `${new Date().toISOString()} ${msg}\n`)
  } catch {
    /* 追踪失败不影响运行 */
  }
}

let win: BrowserWindow | null = null
let store: ConfigStore
let manager: PipeManager
let builtinsInfo: BuiltinsInfo | null = null

function broadcast(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1020,
    minHeight: 660,
    show: false,
    frame: false,
    backgroundColor: '#0b0e14',
    title: 'MCP Console',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.once('ready-to-show', () => win?.show())
  win.webContents.on('did-finish-load', () => trace('did-finish-load'))
  win.webContents.on('did-fail-load', (_e, code, desc, url) => trace(`did-fail-load ${code} ${desc} ${url}`))
  win.webContents.on('preload-error', (_e, file, err) => trace(`preload-error ${file} ${err.message}`))

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev) {
    void win.loadURL(process.env.MCP_CONSOLE_DEV_URL as string)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  const notify = (kind: 'info' | 'error', text: string) => broadcast('toast', { kind, text })
  win.on('maximize', () => notify('info', '最大化'))
  win.on('unmaximize', () => notify('info', '还原'))

  // 打包产物自检：设 MCP_CONSOLE_SMOKE=<输出文件> 时渲染完写一份报告并退出（Windows GUI 进程拿不到 stdout）
  const smokeOut = process.env.MCP_CONSOLE_SMOKE
  if (smokeOut) {
    win.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 1500))
      let payload: Record<string, unknown> = { ok: true }
      try {
        const raw = await win?.webContents.executeJavaScript(
          `JSON.stringify({ nav: document.querySelectorAll('.nav-item').length, cards: document.querySelectorAll('.card').length, brand: (document.querySelector('.brand-text strong') || {}).textContent || null, booting: Boolean(document.querySelector('.boot')), rootChildren: (document.getElementById('root') || {}).childElementCount || 0 })`
        )
        payload = { ok: true, ...JSON.parse(raw) }

        if (process.env.MCP_CONSOLE_SMOKE_FLOW) {
          manager.startAll()
          await new Promise((r) => setTimeout(r, 3500))
          const uiRaw = await win?.webContents.executeJavaScript(
            `JSON.stringify({ pills: [...document.querySelectorAll('.pill')].map((e) => (e.textContent || '').trim()), deviceCards: document.querySelectorAll('.device-card').length, chips: [...document.querySelectorAll('.chip')].map((e) => (e.textContent || '').trim()) })`
          )
          payload.flow = {
            runtime: manager.runtime().map((r) => ({
              device: r.deviceId,
              status: r.status,
              pipes: r.pipes.map((p) => ({
                server: p.serverId,
                status: p.status,
                sent: p.sent,
                received: p.received
              }))
            })),
            ui: JSON.parse(uiRaw ?? '{}')
          }
          payload.logs = manager.logsSnapshot().slice(-12).map((l) => `${l.stream}: ${l.text}`)

          const endpoint = store.current.endpoints[0]
          const server = store.current.servers[0]
          payload.tests = {
            endpoint: endpoint ? await testEndpoint(endpoint) : null,
            server: server ? await testServer(server, store.current.settings) : null,
            tools: server ? await listServerTools(server, store.current.settings) : null,
            call: server
              ? await callServerTool(server, store.current.settings, 'echo', { text: '调试台冒烟' })
              : null
          }

          if (process.env.MCP_CONSOLE_SMOKE_BUILTINS) {
            const dir = builtinsDir()
            const builtins = builtinServers(store.current.settings)
            payload.builtins = {
              dir,
              dirExists: existsSync(dir),
              info: builtinsInfo ?? ensureBuiltins(),
              scripts: builtins.map((s) => (s.args ?? []).join(' ')),
              refs: builtins.map((s) => ({ name: s.name, command: s.command, args: s.args ?? [] })),
              expanded: builtins.map((s) => expandServer(s, store.current.settings)),
              stored: store.current.servers
                .filter((s) => isBuiltinServer(s))
                .map((s) => ({ name: s.name, command: s.command, args: s.args ?? [], note: s.note })),
              envs: builtins.map((s) => ({ name: s.name, env: s.env ?? {} })),
              tests: await Promise.all(builtins.map((s) => testServer(s, store.current.settings)))
            }
            payload.toolchain = await detectToolchain(store.current.settings)
          }
          if (process.env.MCP_CONSOLE_SMOKE_UI) {
            const uiScript = `(async () => {
              window.__rejs = []
              window.addEventListener('unhandledrejection', (e) => window.__rejs.push(String(e.reason)))
              const nav = [...document.querySelectorAll('.nav-item')]
              nav.find((b) => (b.textContent || '').includes('MCP 服务器'))?.click()
              await new Promise((r) => setTimeout(r, 500))
              const loadBtn = [...document.querySelectorAll('.btn')].find((b) => (b.textContent || '').includes('载入内置'))
              loadBtn?.click()
              await new Promise((r) => setTimeout(r, 1500))
              const rowsAfterLoad = document.querySelectorAll('.row').length
              const testBtn = [...document.querySelectorAll('.btn')].find((b) => (b.textContent || '').trim() === '测试')
              testBtn?.click()
              await new Promise((r) => setTimeout(r, 3000))
              const testLines = [...document.querySelectorAll('.test-line')].map((e) => (e.textContent || '').trim())
              const resolvedLines = [...document.querySelectorAll('.rows .row p')]
                .map((e) => (e.textContent || '').trim())
                .filter((t) => t.startsWith('实际执行：'))

              nav.find((b) => (b.textContent || '').includes('设备'))?.click()
              await new Promise((r) => setTimeout(r, 400))
              const newBtn = [...document.querySelectorAll('.btn')].find((b) => (b.textContent || '').includes('新建设备'))
              newBtn?.click()
              await new Promise((r) => setTimeout(r, 400))
              const nameInput = document.querySelector('.modal input')
              const focusTag = document.activeElement ? document.activeElement.tagName : null
              if (nameInput) {
                nameInput.focus()
                document.execCommand('insertText', false, '冒烟设备')
              }
              await new Promise((r) => setTimeout(r, 200))
              const typedValue = document.querySelector('.modal input')?.value ?? null

              nav.find((b) => (b.textContent || '').includes('设置'))?.click()
              // 探测要起 --version 子进程：等到工具路径表真填出来（含 Codex CLI / Python 行）再采，
              // 只数 tr 行数会被无需异步的占位符表提前凑满
              let settingRows = []
              for (let i = 0; i < 30; i += 1) {
                await new Promise((r) => setTimeout(r, 500))
                settingRows = [...document.querySelectorAll('.table tbody tr')].map((e) => (e.textContent || '').trim())
                if (settingRows.some((t) => t.includes('Codex CLI')) && settingRows.some((t) => t.includes('Python'))) break
              }
              // 表没填出来时把接口的返回/异常摊开，别只留一句「正在探测工具路径…」
              let detectCall
              try {
                const r = await window.mcpConsole.detectToolchain(true)
                detectCall = { n: r?.entries?.length ?? null }
              } catch (e) {
                detectCall = { error: String(e).slice(0, 200) }
              }
              const rejs = (window.__rejs || []).slice(0, 3)

              return JSON.stringify({
                loadBtn: Boolean(loadBtn),
                rowsAfterLoad,
                testLines,
                resolvedLines,
                focusTag,
                typedValue,
                settingRows,
                detectCall,
                rejs
              })
            })()`
            payload.ui = JSON.parse((await win?.webContents.executeJavaScript(uiScript)) ?? '{}')
          }
        }
      } catch (err) {
        payload = { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
      writeFileSync(smokeOut, JSON.stringify(payload, null, 2), 'utf8')
      trace(`smoke written ${JSON.stringify(payload)}`)
      app.exit(payload.ok ? 0 : 1)
    })
  }
}

function registerIpc(): void {
  ipcMain.handle('config:get', () => store.current)

  ipcMain.handle('config:save', async (_e, next: AppConfig) => {
    const saved = await store.save(next)
    manager.syncAll()
    return saved
  })

  ipcMain.handle('runtime:get', () => manager.runtime())

  ipcMain.handle('device:start', (_e, id: string) => manager.startDevice(id))
  ipcMain.handle('device:stop', (_e, id: string) => manager.stopDevice(id))
  ipcMain.handle('device:restart', (_e, id: string) => manager.restartDevice(id))
  ipcMain.handle('device:startAll', () => manager.startAll())
  ipcMain.handle('device:stopAll', () => manager.stopAll())

  ipcMain.handle('logs:read', (): LogLine[] => manager.logsSnapshot())
  ipcMain.handle('logs:clear', () => {
    manager.clearLogs()
  })

  ipcMain.handle('endpoint:test', async (_e, id: string) => {
    const endpoint = store.current.endpoints.find((ep) => ep.id === id)
    if (!endpoint) return { ok: false, latencyMs: 0, error: '接入点不存在' }
    const result = await testEndpoint(endpoint)
    manager.note(
      `接入点「${endpoint.name}」${result.ok ? `连通：${result.latencyMs} ms，${result.detail ?? ''}` : `不通：${result.error}`}`
    )
    return result
  })

  ipcMain.handle('server:test', async (_e, id: string) => {
    const server = store.current.servers.find((s) => s.id === id)
    if (!server) return { ok: false, transport: 'stdio' as const, latencyMs: 0, error: '服务器不存在' }
    const result = await testServer(server, store.current.settings)
    manager.note(
      `服务器「${server.name}」${result.ok ? `握手成功：${result.tools?.length ?? 0} 个工具，${result.latencyMs} ms` : `测试失败：${result.error}`}`
    )
    return result
  })

  ipcMain.handle('server:tools', async (_e, id: string) => {
    const server = store.current.servers.find((s) => s.id === id)
    if (!server) return { ok: false, tools: [], latencyMs: 0, error: '服务器不存在' }
    return listServerTools(server, store.current.settings)
  })

  ipcMain.handle('server:call', async (_e, req: ServerCallRequest) => {
    const server = store.current.servers.find((s) => s.id === req?.serverId)
    if (!server) return { ok: false, tool: req?.tool ?? '', elapsedMs: 0, error: '服务器不存在' }
    const result = await callServerTool(
      server,
      store.current.settings,
      String(req.tool ?? ''),
      req.args ?? {},
      Number(req.timeoutMs) > 0 ? Number(req.timeoutMs) : undefined
    )
    manager.note(
      `调试调用「${server.name}」${req.tool}：${result.ok ? `${result.elapsedMs} ms 完成` : `失败 ${result.error}`}`
    )
    return result
  })

  ipcMain.handle('builtins:load', async () => {
    const existing = new Set(store.current.servers.map((s) => s.name))
    const added = builtinServers(store.current.settings).filter((s) => !existing.has(s.name))
    if (!added.length) return { ok: true, added: 0 }
    await store.save({ ...store.current, servers: [...store.current.servers, ...added] })
    manager.syncAll()
    broadcast('config:changed', store.current)
    return { ok: true, added: added.length }
  })

  ipcMain.handle('server:resolve', (_e, id: string): ResolvedServer => {
    const server = store.current.servers.find((s) => s.id === id)
    if (!server) return { ok: false, error: '服务器不存在' }
    try {
      const expanded = expandServer(server, store.current.settings)
      return {
        ok: true,
        name: server.name,
        command: expanded.command,
        args: expanded.args ?? [],
        env: expanded.env ?? {}
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('builtins:info', () => {
    const info = builtinsInfo ?? ensureBuiltins()
    return { ...info, refs: resolveTable(store.current.settings) }
  })

  ipcMain.handle('builtins:repair', async () => {
    builtinsInfo = ensureBuiltins()
    const { servers, result } = repairBuiltinServers(store.current.servers, store.current.settings)
    if (result.fixed) {
      await store.save({ ...store.current, servers })
      manager.syncAll()
      broadcast('config:changed', store.current)
    }
    manager.note(`内置服务器路径自检：${result.checked} 个，修复 ${result.fixed} 个`)
    return result
  })

  ipcMain.handle('shell:builtinsDir', async () => {
    await shell.openPath(builtinsDir())
  })

  ipcMain.handle('toolchain:detect', async (_e, force?: boolean) => {
    const report = await detectToolchain(store.current.settings, Boolean(force))
    invalidateRefs()
    return report
  })

  ipcMain.handle('toolchain:apply', async () => {
    const report = await detectToolchain(store.current.settings)
    let updated = 0
    const servers = store.current.servers.map((server) => {
      const patch = builtinEnvPatch(server, store.current.settings)
      if (!patch) return server
      updated += 1
      const env = { ...(server.env ?? {}), ...patch.env }
      for (const key of patch.drop) delete env[key]
      return { ...server, env }
    })
    if (updated) {
      await store.save({ ...store.current, servers })
      manager.syncAll()
      broadcast('config:changed', store.current)
    }
    manager.note(`工具路径已写入 ${updated} 个内置服务器`)
    return { ok: true, updated, entries: report.entries }
  })

  ipcMain.handle('mcp:import', async () => {
    if (!win) return { ok: false, error: '窗口未就绪' }
    const picked = await dialog.showOpenDialog(win, {
      title: '导入 mcp_config.json',
      defaultPath: path.resolve(process.cwd(), 'mcp_config.json'),
      filters: [{ name: 'MCP 配置', extensions: ['json'] }],
      properties: ['openFile']
    })
    if (picked.canceled || !picked.filePaths.length) return { ok: false, error: '已取消' }
    const filePath = picked.filePaths[0]
    try {
      const previews = await store.readExternal(filePath)
      const existing = new Set(store.current.servers.map((s) => s.name))
      const merged = [
        ...store.current.servers,
        ...previews
          .filter((p) => !existing.has(p.name))
          .map((p) => normalizeServer({ ...p, id: uid('srv') }))
      ]
      await store.save({ ...store.current, servers: merged })
      manager.syncAll()
      broadcast('config:changed', store.current)
      return { ok: true, path: filePath, servers: previews }
    } catch (err) {
      return { ok: false, path: filePath, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('mcp:export', async () => {
    if (!win) return { ok: false, error: '窗口未就绪' }
    const target = await dialog.showSaveDialog(win, {
      title: '导出为 mcp_config.json',
      defaultPath: 'mcp_config.json',
      filters: [{ name: 'MCP 配置', extensions: ['json'] }]
    })
    if (target.canceled || !target.filePath) return { ok: false, error: '已取消' }
    try {
      await store.writeMcpConfig(target.filePath, expandServers(store.current.servers, store.current.settings))
      return { ok: true, path: target.filePath }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('shell:configDir', async () => {
    await shell.openPath(path.dirname(store.file))
  })

  ipcMain.on('window:control', (_e, action: 'minimize' | 'maximize' | 'close') => {
    if (!win) return
    if (action === 'minimize') win.minimize()
    else if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize()
    else win.close()
  })
}

async function bootstrap(): Promise<void> {
  trace('bootstrap:start')
  store = new ConfigStore()
  await store.load()
  trace(`bootstrap:config ${store.file}`)
  builtinsInfo = ensureBuiltins()
  trace(`bootstrap:builtins mode=${builtinsInfo.mode} dir=${builtinsInfo.dir} copied=${builtinsInfo.copied ?? 0} writable=${builtinsInfo.writable}`)
  const repaired = repairBuiltinServers(store.current.servers, store.current.settings)
  if (repaired.result.fixed) {
    await store.save({ ...store.current, servers: repaired.servers })
    trace(`bootstrap:builtins repaired=${repaired.result.fixed} ${repaired.result.details.join(' | ')}`)
  }
  manager = new PipeManager(store)
  manager.on('runtime', (runtime) => broadcast('runtime', runtime))
  manager.on('logs', (lines) => broadcast('logs', lines))

  registerIpc()
  trace('bootstrap:ipc ready')
  createWindow()
  trace('bootstrap:window created')

  if (store.current.settings.autoStartAll) manager.startAll()
  else for (const device of store.current.devices) if (device.autoStart) manager.startDevice(device.id)
}

const gotLock = app.requestSingleInstanceLock()
trace(`singleInstanceLock=${gotLock}`)
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(async () => {
    trace('app ready')
    Menu.setApplicationMenu(null)
    await bootstrap()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    manager?.dispose()
    app.quit()
  })
}
