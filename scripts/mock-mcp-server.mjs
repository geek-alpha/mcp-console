import { createInterface } from 'node:readline'

process.stderr.write('mock mcp server ready\n')

const TOOLS = [
  {
    name: 'echo',
    description: '回显文本',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } }
  },
  { name: 'now', description: '当前时间', inputSchema: { type: 'object', properties: {} } }
]

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`)

createInterface({ input: process.stdin }).on('line', (line) => {
  const text = line.trim()
  if (!text) return
  let msg = null
  try {
    msg = JSON.parse(text)
  } catch {
    msg = null
  }
  const id = msg?.id ?? null
  const method = msg?.method

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mock-mcp', version: '0.0.1' }
      }
    })
    return
  }
  if (typeof method === 'string' && method.startsWith('notifications/')) return
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
    return
  }
  if (method === 'tools/call') {
    const name = msg?.params?.name
    const args = msg?.params?.arguments ?? {}
    const text =
      name === 'echo'
        ? `echo:${args.text ?? ''}`
        : name === 'now'
          ? new Date().toISOString()
          : `未知工具：${name}`
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: false } })
    return
  }
  // 管道冒烟依赖这条：其余请求一律回 pong:<原文>，用来验证双向转发
  send({ jsonrpc: '2.0', id, result: `pong:${text}` })
})
