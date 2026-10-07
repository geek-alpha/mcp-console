import { hasPlaceholder, resolveTemplate, samePath } from '../src/main/paths.ts'

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    pass += 1
    console.log(`PASS  ${name}${detail ? `  ${detail}` : ''}`)
  } else {
    fail += 1
    console.log(`FAIL  ${name}${detail ? `  ${detail}` : ''}`)
  }
}

const ctxA = {
  app: 'C:\\App',
  resources: 'C:\\App\\resources',
  servers: 'D:\\Green\\mcp-console-data\\servers',
  node: 'C:\\nvm4w\\nodejs\\node.exe',
  python: 'C:\\py\\python.exe',
  tools: { codex: 'C:\\codex\\codex.exe' }
}
const ctxB = {
  ...ctxA,
  app: 'E:\\Portable',
  servers: 'E:\\Portable\\mcp-console-data\\servers',
  tools: {}
}

check('{node} 解析成运行时', resolveTemplate('{node}', ctxA) === ctxA.node, resolveTemplate('{node}', ctxA))
check(
  '{servers}/codex.cjs 拼接正确',
  resolveTemplate('{servers}/codex.cjs', ctxA) === 'D:\\Green\\mcp-console-data\\servers/codex.cjs'
)
check(
  '同一份配置换目录后解析跟着变',
  resolveTemplate('{servers}/codex.cjs', ctxB) === 'E:\\Portable\\mcp-console-data\\servers/codex.cjs',
  resolveTemplate('{servers}/codex.cjs', ctxB)
)
check('{tool:codex} 用探测结果', resolveTemplate('{tool:codex}', ctxA) === 'C:\\codex\\codex.exe')
check(
  '{tool:codex} 探测不到时保留原文（调用方据此丢掉该变量）',
  resolveTemplate('{tool:codex}', ctxB) === '{tool:codex}'
)
check('{python} 解析', resolveTemplate('{python}', ctxA) === 'C:\\py\\python.exe')
check(
  '{app} / {resources} 解析',
  resolveTemplate('{app}/x', ctxA) === 'C:\\App/x' && resolveTemplate('{resources}', ctxA) === ctxA.resources
)
check('未知花括号原样保留', resolveTemplate('{foo}', ctxA) === '{foo}' && resolveTemplate('a{b}c', ctxA) === 'a{b}c')
check('普通命令不动', resolveTemplate('npx.cmd', ctxA) === 'npx.cmd')
check(
  'hasPlaceholder 判定（含 undefined）',
  hasPlaceholder('{node}') === true && hasPlaceholder('python') === false && hasPlaceholder(undefined) === false
)
check(
  'samePath 大小写与斜杠不敏感',
  samePath('C:\\A\\b.exe', 'c:/a/B.EXE') === true && samePath('C:\\A', 'C:\\B') === false
)
check('多次解析不残留（正则状态不串）', resolveTemplate('{node}|{node}', ctxA) === `${ctxA.node}|${ctxA.node}`)

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail ? 1 : 0)
