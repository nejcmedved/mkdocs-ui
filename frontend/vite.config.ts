import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// BACKEND_URL lets the dev server run in docker-compose-dev.yaml, where the backend is "backend:8000"
const backend = process.env.BACKEND_URL ?? 'http://localhost:8000'

export default defineConfig({
  plugins: [react()],
  server: {
    watch: process.env.VITE_POLLING ? { usePolling: true, interval: 300 } : undefined,
    proxy: {
      '/api': backend,
      '/ws': { target: backend.replace(/^http/, 'ws'), ws: true },
    },
  },
})
