import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

/**
 * 纯 node 环境（冒烟脚本直接 require dist/main）里 electron 的 app 是 undefined，
 * 这里统一降级到 cwd，免得整条「配置 → 真实命令」的解析链挂掉。
 */
function electronApp(): typeof app | undefined {
  return app && typeof app.isPackaged === 'boolean' ? app : undefined
}

export function isPackaged(): boolean {
  return electronApp()?.isPackaged === true
}

export function appPath(): string {
  return electronApp()?.getAppPath() ?? process.cwd()
}

export function exeDir(): string {
  const e = electronApp()
  if (e?.isPackaged) return path.dirname(e.getPath('exe'))
  return appPath()
}

function userDataPath(): string {
  try {
    return electronApp()?.getPath('userData') ?? path.join(process.cwd(), '.mcp-console-userdata')
  } catch {
    return path.join(process.cwd(), '.mcp-console-userdata')
  }
}

/**
 * 便携版（portable exe）每次运行都把自己解压到 %TEMP%\<随机>\，
 * 于是 process.execPath / process.resourcesPath 每次都变——稳定锚点只有 exe 所在目录。
 */
export function portableDir(): string | null {
  const dir = process.env.PORTABLE_EXECUTABLE_DIR?.trim()
  return dir || null
}

/** 助手脚本源目录：打包后在 resources 里，开发时就是项目根的 servers/ */
export function sourceServersDir(): string {
  return isPackaged() ? path.join(process.resourcesPath, 'servers') : path.join(appPath(), 'servers')
}

export function builtinsMode(): 'dev' | 'portable' | 'installed' {
  if (!isPackaged()) return 'dev'
  return portableDir() ? 'portable' : 'installed'
}

/** 稳定数据目录：便携版优先 exe 同级的 mcp-console-data（绿色版数据跟着 exe 走），写不动就退 userData */
export function stableDataDir(): { dir: string; mode: 'portable' | 'userData' } {
  const portable = portableDir()
  if (portable) {
    const candidate = path.join(portable, 'mcp-console-data')
    try {
      mkdirSync(candidate, { recursive: true })
      return { dir: candidate, mode: 'portable' }
    } catch {
      /* exe 目录只读（写保护 U 盘 / Program Files）→ 退 userData */
    }
  }
  return { dir: userDataPath(), mode: 'userData' }
}

let activeDir: string | null = null

export function setActiveBuiltinsDir(dir: string | null): void {
  activeDir = dir
}

/**
 * 生效的脚本目录：安装版读包内（安装位置一变 resourcesPath 跟着变），
 * 便携版读释放出来的稳定目录——都由当前进程现场算，配置里不存绝对路径。
 */
export function builtinsDir(): string {
  if (activeDir) return activeDir
  if (!isPackaged()) return sourceServersDir()
  if (!portableDir()) return sourceServersDir()
  return path.join(stableDataDir().dir, 'servers')
}
