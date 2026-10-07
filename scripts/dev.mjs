import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'vite'
import electronPath from 'electron'

execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.main.json'], {
  stdio: 'inherit'
})

const server = await createServer({ server: { port: 5183, strictPort: true } })
await server.listen()
const url = `http://localhost:${server.config.server.port}`

const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, MCP_CONSOLE_DEV_URL: url }
})

child.on('exit', async () => {
  await server.close()
  process.exit(0)
})
