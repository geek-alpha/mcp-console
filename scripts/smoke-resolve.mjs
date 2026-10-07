#!/usr/bin/env node
'use strict'
/**
 * servers/lib/agent.cjs 的可执行文件 / 目录解析冒烟：
 * 验证「环境变量 → PATH → 常见位置 → 兜底」四级回退与告警，不依赖目标机器装了什么工具。
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const require = createRequire(import.meta.url)
const { resolveBinDetail, resolveDir } = require('../servers/lib/agent.cjs')

let pass = 0
let fail = 0
const check = (name, cond, extra) => {
  if (cond) {
    pass += 1
    console.log(`PASS  ${name}`)
  } else {
    fail += 1
    console.log(`FAIL  ${name}${extra ? ` → ${JSON.stringify(extra)}` : ''}`)
  }
}

const nodeDir = path.dirname(process.execPath)
const originalPath = process.env.PATH

process.env.PATH = nodeDir + path.delimiter + originalPath
delete process.env.MCP_TEST_BIN
const viaPath = resolveBinDetail({ bin: 'node', binNames: ['node'], binEnv: 'MCP_TEST_BIN' })
check('PATH 命中可执行文件', viaPath.source === 'path' && fs.existsSync(viaPath.bin), viaPath)

process.env.MCP_TEST_BIN = process.execPath
const viaEnv = resolveBinDetail({ bin: 'node', binNames: ['node'], binEnv: 'MCP_TEST_BIN' })
check('环境变量优先于 PATH', viaEnv.source === 'env' && viaEnv.bin === process.execPath, viaEnv)

process.env.MCP_TEST_BIN = path.join(os.tmpdir(), 'not-here', 'ghost-bin')
const ghost = process.env.MCP_TEST_BIN
const badEnv = resolveBinDetail({ bin: 'node', binNames: ['node'], binEnv: 'MCP_TEST_BIN' })
// env 值不可用不能就地放弃：老配置里残留一个占位值，就地返回会把 PATH 兜底一起掉死
check(
  'env 失效时继续兜底并保留告警',
  badEnv.source !== 'env' && badEnv.bin !== ghost && String(badEnv.warn ?? '').includes('MCP_TEST_BIN'),
  badEnv
)

process.env.MCP_TEST_BIN = 'node'
const viaName = resolveBinDetail({ bin: 'node', binNames: ['node'], binEnv: 'MCP_TEST_BIN' })
// 老配置里存的是命令名（'python'）而不是路径：直接 path.resolve 会变成 cwd 下的假路径
check('env 写命令名时按 PATH 解析', viaName.source === 'env' && fs.existsSync(viaName.bin), viaName)
check('命令名命中时不报「路径不可用」', !viaName.warn, viaName)

process.env.MCP_TEST_BIN = 'definitely-not-a-command-xyz'
const viaBadName = resolveBinDetail({ bin: 'node', binNames: ['node'], binEnv: 'MCP_TEST_BIN' })
check(
  '命令名不存在时继续兜底并说明不是路径',
  viaBadName.source === 'path' && /不是路径/.test(viaBadName.warn ?? ''),
  viaBadName
)

delete process.env.MCP_TEST_BIN
process.env.PATH = ''
const viaCommon = resolveBinDetail({
  bin: 'node',
  binNames: ['node'],
  binEnv: 'MCP_TEST_BIN',
  commonPaths: [process.execPath]
})
check('PATH 为空时走常见安装位置', viaCommon.source === 'common' && viaCommon.bin === process.execPath, viaCommon)

const missing = resolveBinDetail({
  bin: 'definitely-not-installed-xyz',
  binNames: ['definitely-not-installed-xyz'],
  binEnv: 'MCP_TEST_BIN',
  commonPaths: []
})
check('全找不到时退回名字并告警', missing.source === 'fallback' && /没找到/.test(missing.warn ?? ''), missing)

const ext = resolveBinDetail({ bin: 'codex.cmd', binNames: [] })
check('默认 bin 的 .cmd 后缀被剥掉再搜', Array.isArray(ext.names) && ext.names[0] === 'codex', ext)

process.env.PATH = originalPath

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-resolve-'))
fs.writeFileSync(path.join(tmp, 'dabai_cli.py'), '# smoke\n')
delete process.env.MCP_TEST_DIR
const viaMarker = resolveDir({
  envKey: 'MCP_TEST_DIR',
  markers: ['dabai_cli.py'],
  commonPaths: [tmp],
  fallback: os.tmpdir()
})
check('目录型工具按标志文件命中', viaMarker.source === 'common' && viaMarker.dir === path.resolve(tmp), viaMarker)

process.env.MCP_TEST_DIR = tmp
const viaDirEnv = resolveDir({ envKey: 'MCP_TEST_DIR', markers: ['dabai_cli.py'], commonPaths: [], fallback: os.tmpdir() })
check('目录型工具 env 优先', viaDirEnv.source === 'env' && viaDirEnv.dir === path.resolve(tmp), viaDirEnv)
delete process.env.MCP_TEST_DIR

const dirMissing = resolveDir({ envKey: 'MCP_TEST_DIR', markers: ['nope'], commonPaths: [], fallback: tmp })
check('目录找不到时给告警', dirMissing.source === 'fallback' && Boolean(dirMissing.warn), dirMissing)

fs.rmSync(tmp, { recursive: true, force: true })

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
