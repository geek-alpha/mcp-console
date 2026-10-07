#!/usr/bin/env node
'use strict'
/**
 * 只给冒烟用的「连不上」探针：借 agent 骨架起一个注定起不来的进程，验证端侧拿到的是失败而不是假成功。
 * PROBE_MODE=missing（可执行文件不存在）| exit（起来就非零退出）
 */
const { serve } = require('../../servers/lib/agent.cjs')

const mode = process.env.PROBE_MODE || 'missing'
const isExit = mode === 'exit'

serve({
  name: 'probe',
  label: 'Probe',
  bin: isExit ? process.env.ComSpec || 'cmd.exe' : 'definitely-not-installed-xyz',
  binNames: isExit ? ['cmd'] : ['definitely-not-installed-xyz'],
  commonPaths: [],
  cwd: process.cwd(),
  buildArgs() {
    return isExit ? ['/d', '/s', '/c', 'exit 3'] : ['--nope']
  }
})
