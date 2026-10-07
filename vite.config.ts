import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

const root = process.cwd()

export default defineConfig({
  root: resolve(root, 'src/renderer'),
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve(root, 'dist/renderer'),
    emptyOutDir: true,
    target: 'chrome120',
    chunkSizeWarningLimit: 1200
  },
  server: {
    port: 5183,
    strictPort: true
  }
})
