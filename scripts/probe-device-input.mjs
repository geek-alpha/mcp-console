import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const { app, BrowserWindow, ipcMain } = require('electron')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'probe-device-input.json')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const config = {
  version: 1,
  endpoints: [{ id: 'ep_probe', name: '探针接入点', url: 'ws://127.0.0.1:8799', enabled: true, note: '' }],
  servers: [
    {
      id: 'srv_probe',
      name: '探针服务器',
      transport: 'stdio',
      command: 'node',
      args: [],
      cwd: '',
      env: {},
      enabled: true,
      note: ''
    }
  ],
  devices: [
    {
      id: 'dev_probe',
      name: '已有设备',
      endpointId: 'ep_probe',
      serverIds: ['srv_probe'],
      autoStart: false,
      note: ''
    }
  ],
  settings: { pythonPath: 'python', logLimit: 800, maxBackoffMs: 5000, autoStartAll: false }
}

const report = { console: [], steps: [] }
const step = (name, data) => {
  report.steps.push({ name, ...data })
  console.log(name, JSON.stringify(data))
}

ipcMain.handle('config:get', () => config)
ipcMain.handle('runtime:get', () => [])
ipcMain.handle('logs:read', () => [])
ipcMain.handle('config:save', (_e, next) => next)
ipcMain.handle('device:startAll', () => [])
ipcMain.handle('device:stopAll', () => [])

const readState = (win) =>
  win.webContents
    .executeJavaScript(
      `JSON.stringify({
        modalOpen: Boolean(document.querySelector('.modal')),
        modalTitle: (document.querySelector('.modal-head h3') || {}).textContent || null,
        fields: [...document.querySelectorAll('.modal input')].map((i) => ({
          value: i.value,
          type: i.type,
          disabled: i.disabled,
          readOnly: i.readOnly,
          color: getComputedStyle(i).color,
          bg: getComputedStyle(i).backgroundColor,
          caret: getComputedStyle(i).caretColor,
          rect: (() => { const r = i.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } })(),
          hit: (() => { const r = i.getBoundingClientRect(); const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return el ? el.tagName + (el.className ? '.' + String(el.className).split(' ')[0] : '') : null })()
        })),
        active: document.activeElement ? document.activeElement.tagName + (document.activeElement.className ? '.' + String(document.activeElement.className).split(' ')[0] : '') : null
      })`
    )
    .then((raw) => JSON.parse(raw))

const typeKeys = async (win, text) => {
  for (const ch of text) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch })
    win.webContents.sendInputEvent({ type: 'char', keyCode: ch })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch })
    await sleep(60)
  }
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    show: true,
    frame: false,
    backgroundColor: '#0b0e14',
    webPreferences: {
      preload: path.join(root, 'dist', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.webContents.on('console-message', (...args) => {
    const first = args[0]
    if (first && typeof first === 'object' && 'message' in first) {
      report.console.push(`${first.level}: ${first.message}`)
    } else {
      report.console.push(`${args[1]}: ${args[2]}`)
    }
  })

  try {
    await win.loadFile(path.join(root, 'dist', 'renderer', 'index.html'))
    await sleep(1500)
    win.show()
    win.focus()
    win.webContents.focus()
    await sleep(300)

    await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('.nav-item')].find((b) => (b.textContent || '').includes('设备'))?.click()`
    )
    await sleep(500)
    step('打开设备页', await readState(win))

    await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('.btn')].find((b) => (b.textContent || '').includes('新建设备'))?.click()`
    )
    await sleep(500)
    const opened = await readState(win)
    step('点击新建设备', opened)

    if (!opened.modalOpen) {
      report.summary = '模态框没有打开，问题在更早的一层'
      writeFileSync(out, JSON.stringify(report, null, 2), 'utf8')
      app.exit(1)
      return
    }

    const target = opened.fields[0]
    const cx = target.rect.x + target.rect.w / 2
    const cy = target.rect.y + target.rect.h / 2

    win.webContents.sendInputEvent({ type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: cx, y: cy, button: 'left', clickCount: 1 })
    await sleep(300)
    step('真实鼠标点击名称框', await readState(win))

    await typeKeys(win, 'abc')
    step('真实按键 abc', await readState(win))

    await win.webContents.executeJavaScript(
      `document.activeElement && document.activeElement.focus(), document.execCommand('insertText', false, '汉字')`
    )
    await sleep(300)
    step('execCommand 插入汉字', await readState(win))

    await win.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('.modal input')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, 'setter注入')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await sleep(300)
    step('原生 setter 注入', await readState(win))

    await typeKeys(win, 'xy')
    step('再按键 xy', await readState(win))

    await win.webContents.executeJavaScript(`document.querySelector('.modal-close')?.click()`)
    await sleep(400)
    await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('.btn')].find((b) => (b.textContent || '').trim() === '编辑')?.click()`
    )
    await sleep(500)
    const editing = await readState(win)
    step('打开编辑设备', editing)

    if (editing.modalOpen) {
      const first = editing.fields[0]
      win.webContents.sendInputEvent({
        type: 'mouseDown',
        x: first.rect.x + first.rect.w / 2,
        y: first.rect.y + first.rect.h / 2,
        button: 'left',
        clickCount: 1
      })
      win.webContents.sendInputEvent({
        type: 'mouseUp',
        x: first.rect.x + first.rect.w / 2,
        y: first.rect.y + first.rect.h / 2,
        button: 'left',
        clickCount: 1
      })
      await sleep(250)
      await typeKeys(win, 'Q')
      step('编辑路径输入 Q', await readState(win))
    }

    report.summary = 'probe done'
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err)
  }

  writeFileSync(out, JSON.stringify(report, null, 2), 'utf8')
  app.exit(0)
})
