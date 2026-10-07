#!/usr/bin/env node
'use strict'
/**
 * OpenCode 服务器：把 opencode-ai 的启动/终止/状态做成 MCP 工具。
 * 给了 prompt 走 `opencode run <prompt>`；没给则起 headless 服务 `opencode serve --port 4096`。
 */
const os = require('node:os')
const { serve } = require('./lib/agent.cjs')

const SERVE_PORT = Number(process.env.MCP_AGENT_OPENCODE_PORT || 4096)

serve({
  name: 'opencode',
  label: 'OpenCode CLI',
  bin: 'opencode',
  binNames: ['opencode'],
  binEnv: 'MCP_AGENT_OPENCODE_BIN',
  commonPaths: [
    '%LOCALAPPDATA%/opencode/opencode.exe',
    '%APPDATA%/npm/opencode.cmd',
    '~/.opencode/bin/opencode',
    '~/.bun/bin/opencode',
    '/usr/local/bin/opencode',
    '~/.local/bin/opencode'
  ],
  cwd: process.env.MCP_AGENT_OPENCODE_CWD || os.homedir(),
  promptHint: '交给 opencode run 的任务描述；留空则起 headless 服务（serve）',
  buildArgs({ prompt, args }) {
    if (args && args.length) return args
    if (prompt) return ['run', prompt]
    return { argv: ['serve', '--hostname', '127.0.0.1', '--port', String(SERVE_PORT)], port: SERVE_PORT }
  }
})
