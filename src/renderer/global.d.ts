import type { ConsoleApi } from '../shared/types'

declare global {
  interface Window {
    mcpConsole: ConsoleApi
  }
}

export {}
