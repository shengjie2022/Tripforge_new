import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// base: './' —— 相对路径产物，让 GitHub Pages 的项目站点
// (https://<user>.github.io/<repo>/) 和自定义域名都能直接跑通
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
})
