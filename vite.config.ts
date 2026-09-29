import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// MSS only sends CORS headers for its own site, so the browser won't let us
// read its radar pixels directly (needed to measure how rain is moving).
// Serving them same-origin through this proxy fixes that. A production host
// needs the equivalent rewrite (/mss-radar/* -> weather.gov.sg/files/rainarea/*);
// without it the app falls back to the plain image overlay automatically.
const mssProxy = {
  '/mss-radar': {
    target: 'https://www.weather.gov.sg',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/mss-radar/, '/files/rainarea'),
  },
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // MapLibre's tile worker is an ES module.
  worker: { format: 'es' },
  server: { proxy: mssProxy },
  preview: { proxy: mssProxy },
})
