/**
 * 端到端冒烟：mock 接入点 + mock MCP 服务器，验证 PipeRunner 双向转发与断线重连。
 * 运行：node scripts/smoke-pipe.mjs
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { WebSocketServer } from 'ws'

const require = createRequire(import.meta.url)
const { PipeRunner } = require('../dist/main/pipe.js')

const PORT = 8799
const root = process.cwd()
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const wss = new WebSocketServer({ port: PORT })
const received = []
let conn = null
let connections = 0

wss.on('connection', (ws) => {
  connections += 1
  conn = ws
  ws.on('message', (data) => received.push(data.toString()))
})

const device = { id: 'dev_test', name: '冒烟设备', endpointId: 'ep_test', serverIds: ['srv_test'], autoStart: false }
const endpoint = { id: 'ep_test', name: '冒烟接入点', url: `ws://127.0.0.1:${PORT}`, enabled: true }
const mockServer = {
  id: 'srv_test',
  name: 'mock-mcp',
  transport: 'stdio',
  enabled: true,
  command: process.execPath,
  args: [path.join(root, 'scripts', 'mock-mcp-server.mjs')]
}
const settings = { pythonPath: 'python', logLimit: 200, maxBackoffMs: 1000, autoStartAll: false }

const logs = []
const runner = new PipeRunner(device, mockServer, endpoint, settings, {
  log: (stream, text) => logs.push(`[${stream}] ${text}`),
  state: (state) => logs.push(`[state] ${state.status}`)
})

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
}

runner.start()
await wait(1500)

check('接入点已连接', connections >= 1, `connections=${connections}`)
check('管道状态 running', runner.snapshot.status === 'running', `status=${runner.snapshot.status}`)

if (!conn) {
  console.log('没有可用的接入点连接，后续断言跳过')
  console.log(logs.join('\n'))
  process.exit(1)
}

conn.send('{"jsonrpc":"2.0","id":1,"method":"ping"}')
await wait(900)
const echoed = received.find((line) => line.includes('pong:'))
check('下行消息被服务器处理并回传', Boolean(echoed), echoed ? echoed.trim() : `received=${received.length}`)

const firstConn = conn
firstConn.close()
await wait(2500)
check('断线后自动重连', connections >= 2, `connections=${connections}`)
check('重连后状态恢复 running', runner.snapshot.status === 'running', `status=${runner.snapshot.status}`)

const afterReconnect = received.length
conn?.send('{"jsonrpc":"2.0","id":2,"method":"ping"}')
await wait(900)
check('重连后消息仍能往返', received.length > afterReconnect, `received=${received.length}`)

runner.stop()
await wait(300)
check('停止后状态为 stopped', runner.snapshot.status === 'stopped', `status=${runner.snapshot.status}`)

wss.close()
const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`)
if (failed.length) console.log('日志：\n' + logs.slice(-20).join('\n'))
process.exit(failed.length ? 1 : 0)
