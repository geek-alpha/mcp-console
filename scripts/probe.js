const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const out = path.join(__dirname, '..', 'probe.txt')
const log = (msg) => fs.appendFileSync(out, `${msg}\n`)

fs.writeFileSync(out, `electron=${process.versions.electron} chrome=${process.versions.chrome}\n`)

app.whenReady().then(async () => {
  log('app ready')
  const win = new BrowserWindow({
    width: 900,
    height: 600,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'dist', 'preload', 'index.js'),
      contextIsolation: true,
      sandbox: false
    }
  })

  win.webContents.on('console-message', (...args) => {
    const first = args[0]
    if (first && typeof first === 'object' && 'message' in first) {
      log(`console ${first.level}: ${first.message} @${first.sourceId}:${first.lineNumber}`)
    } else {
      log(`console ${args[1]}: ${args[2]}`)
    }
  })
  win.webContents.on('did-fail-load', (_e, code, desc, url) => log(`fail-load ${code} ${desc} ${url}`))
  win.webContents.on('render-process-gone', (_e, details) => log(`render-gone ${JSON.stringify(details)}`))
  win.webContents.on('preload-error', (_e, file, err) => log(`preload-error ${file} ${err.message}`))

  try {
    await win.loadFile(path.join(__dirname, '..', 'dist', 'renderer', 'index.html'))
    log('renderer loaded')
    await new Promise((r) => setTimeout(r, 1800))
    const nav = await win.webContents.executeJavaScript("document.querySelectorAll('.nav-item').length")
    const api = await win.webContents.executeJavaScript('typeof window.mcpConsole')
    const boot = await win.webContents.executeJavaScript("!!document.querySelector('.boot')")
    const root = await win.webContents.executeJavaScript(
      "(document.getElementById('root')||{}).innerHTML ? document.getElementById('root').innerHTML.slice(0, 160) : 'EMPTY'"
    )
    log(`nav=${nav} api=${api} boot=${boot}`)
    log(`root=${root}`)
  } catch (err) {
    log(`error: ${err.message}`)
  }
  log('done')
  app.exit(0)
})
