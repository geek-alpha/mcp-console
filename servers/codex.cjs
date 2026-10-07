#!/usr/bin/env node
'use strict'
/**
 * Codex CLI 服务器：把 @openai/codex 的启动/终止/状态做成 MCP 工具。
 * 任务模式走 `codex exec <prompt>`（非交互跑完即退），日志落盘，可随时 stop。
 */
const os = require('node:os')
const { serve } = require('./lib/agent.cjs')

serve({
  name: 'codex',
  label: 'Codex CLI',
  bin: 'codex',
  binNames: ['codex'],
  binEnv: 'MCP_AGENT_CODEX_BIN',
  commonPaths: [
    '%APPDATA%/npm/codex.cmd',
    '~/.npm-global/bin/codex',
    '~/.bun/bin/codex',
    '~/.volta/bin/codex',
    '/usr/local/bin/codex',
    '~/.local/bin/codex'
  ],
  cwd: process.env.MCP_AGENT_CODEX_CWD || os.homedir(),
  promptHint: '交给 codex exec 的任务描述，例如：把这个仓库的 README 翻译成中文',
  buildArgs({ prompt, args }) {
    if (args && args.length) return args
    if (prompt) return ['exec', prompt]
    throw new Error('codex 需要 prompt（走 codex exec 跑任务），或显式传 args 指定完整参数')
  }
})
