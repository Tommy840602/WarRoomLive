import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// During development the Vite dev server proxies API and WebSocket traffic to the
// Spring Boot backend on :8080, so the browser only ever talks to :5173.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
})
