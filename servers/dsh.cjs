#!/usr/bin/env node
'use strict'
/**
 * DSH（DeepSeek Harness）服务器：把 dsh 的启动/终止/状态做成 MCP 工具。
 * 给了 prompt 走 `dsh --profile headless <prompt>`（跑完即退）；没给则起 Web UI（默认 3080）。
 * dsh 是 pnpm workspace，命令必须在仓库根目录执行——仓库位置自动探测，也可在控制台设置页指定。
 */
const { serve, resolveDir } = require('./lib/agent.cjs')

const DSH = resolveDir({
  envKey: 'MCP_AGENT_DSH_HOME',
  markers: ['pnpm-workspace.yaml', 'dsh.config.json', 'package.json'],
  commonPaths: [
    'D:/ai/deepseek-harness',
    '%USERPROFILE%/deepseek-harness',
    '~/deepseek-harness',
    '~/projects/deepseek-harness',
    '~/.dsh'
  ],
  fallback: 'D:/ai/deepseek-harness'
})
const WEB_PORT = Number(process.env.MCP_AGENT_DSH_PORT || 3080)

serve({
  name: 'dsh',
  label: 'DSH（DeepSeek Harness）',
  bin: 'pnpm',
  binNames: ['pnpm', 'dsh'],
  binEnv: 'MCP_AGENT_DSH_BIN',
  commonPaths: [
    '%APPDATA%/npm/pnpm.cmd',
    '%LOCALAPPDATA%/pnpm/pnpm.exe',
    '~/.local/share/pnpm/pnpm',
    '~/.dsh/bin/dsh',
    '/usr/local/bin/pnpm',
    '/opt/homebrew/bin/pnpm'
  ],
  cwd: DSH.dir,
  promptHint: '交给 dsh headless profile 的任务描述；留空则起 Web UI（--no-open）',
  buildArgs({ prompt, args }) {
    if (args && args.length) return args
    if (prompt) return ['dsh', '--profile', 'headless', prompt]
    return { argv: ['dsh', 'web', '--no-open', '--port', String(WEB_PORT)], port: WEB_PORT }
  }
})
