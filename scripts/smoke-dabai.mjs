/**
 * 大白服务器自检：
 *  ① 走控制台同一条路径（tester.js + Electron 自带 node）做真实 MCP 握手，断言 6 个带前缀工具齐全
 *  ② 真调 dabai_health：python / dabai_cli.py / 工作目录三项都要就位
 *  ③ 设 MCP_CONSOLE_SMOKE_ASK=1 时真跑一轮 dabai_ask（要连模型，几十秒起，默认跳过）
 * 运行：node scripts/smoke-dabai.mjs
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { testServer } = require('../dist/main/tester.js')
const electronPath = require('electron')

const here = path.dirname(fileURLToPath(import.meta.url))
const script = path.join(here, '..', 'servers', 'dabai.cjs')
const settings = { pythonPath: 'python', logLimit: 800, maxBackoffMs: 5000, autoStartAll: false }
const EXPECT = ['dabai_ask', 'dabai_health', 'dabai_start', 'dabai_stop', 'dabai_status', 'dabai_logs']

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
}

const server = {
  id: 'srv_dabai',
  name: '大白 CLI',
  transport: 'stdio',
  enabled: true,
  command: electronPath,
  args: [script],
  env: { ELECTRON_RUN_AS_NODE: '1' }
}

function connect() {
  const child = spawn(server.command, server.args, { env: { ...process.env, ...server.env } })
  const pending = new Map()
  let buffer = ''
  let nextId = 1

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      const waiter = pending.get(msg.id)
      if (waiter) {
        pending.delete(msg.id)
        waiter(msg)
      }
    }
  })

  const request = (method, params, timeoutMs = 120000) => {
    const id = nextId++
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`超时：${method}`))
      }, timeoutMs)
      pending.set(id, (msg) => {
        clearTimeout(timer)
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
      })
    })
  }

  return {
    request,
    async call(name, args, timeoutMs) {
      const result = await request('tools/call', { name, arguments: args ?? {} }, timeoutMs)
      const text = result?.content?.[0]?.text ?? ''
      if (result?.isError) throw new Error(text)
      try {
        return JSON.parse(text)
      } catch {
        return text
      }
    },
    close() {
      child.stdin.end()
      child.kill()
    }
  }
}

console.log('=== ① 握手 + 工具清单 ===')
const handshake = await testServer(server, settings, 25000)
check('dabai 握手通过', handshake.ok, handshake.error ?? '')
const tools = handshake.tools ?? []
check('暴露 6 个带前缀工具', EXPECT.every((t) => tools.includes(t)), `tools=${JSON.stringify(tools)}`)

console.log('\n=== ② dabai_health ===')
const client = connect()
try {
  await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {} })
  const health = await client.call('dabai_health')
  check('health ok', health?.ok === true, JSON.stringify(health))
  check('python 可用', Boolean(health?.pythonVersion), `python=${health?.python} ${health?.pythonVersion ?? ''}`)
  check('dabai_cli.py 就位', health?.cliExists === true, health?.cli ?? '')

  if (process.env.MCP_CONSOLE_SMOKE_ASK) {
    console.log('\n=== ③ dabai_ask 真跑一轮 ===')
    const answer = await client.call('dabai_ask', { prompt: '只回复两个字：收到', timeoutMs: 300000 }, 320000)
    check('ask 有回复正文', typeof answer?.reply === 'string' && answer.reply.length > 0, answer?.reply?.slice(0, 80) ?? '')
    check(
      'ask 带回耗时与退出码',
      typeof answer?.elapsedMs === 'number' && answer?.exitCode !== undefined,
      `elapsedMs=${answer?.elapsedMs} exitCode=${answer?.exitCode}`
    )
  }
} catch (err) {
  check(`工具调用（${err.message}）`, false)
} finally {
  client.close()
}

const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`)
process.exit(failed.length ? 1 : 0)
