import { defineConfig, loadEnv, type Plugin } from 'vite'
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

// Serves the weather companion's Netlify function at the same path in dev,
// so `npm run dev` works without the Netlify CLI. The function is loaded
// through Vite on every request, so edits to it apply without a restart.
function companionDevApi(): Plugin {
  return {
    name: 'companion-dev-api',
    configureServer(server) {
      server.middlewares.use('/api/companion', async (req, res) => {
        try {
          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(chunk as Buffer)
          const abort = new AbortController()
          res.on('close', () => abort.abort())
          // Host, Origin and the client IP as Netlify would pass them, for the
          // function's same-origin check and rate limits.
          const headers: Record<string, string> = {
            'Content-Type': req.headers['content-type'] ?? 'application/json',
            'x-nf-client-connection-ip': req.socket.remoteAddress ?? 'unknown',
          }
          if (req.headers.origin) headers.Origin = req.headers.origin
          const request = new Request(`http://${req.headers.host ?? 'localhost'}${req.originalUrl ?? '/api/companion'}`, {
            method: req.method,
            headers,
            body: req.method === 'POST' ? Buffer.concat(chunks) : undefined,
            signal: abort.signal,
          })
          const mod = await server.ssrLoadModule('/netlify/functions/companion.ts')
          const response: Response = await mod.default(request)
          res.statusCode = response.status
          response.headers.forEach((value, key) => res.setHeader(key, value))
          if (response.body) {
            for await (const chunk of response.body) res.write(chunk)
          }
          res.end()
        } catch (e) {
          server.config.logger.error(`companion: ${e instanceof Error ? e.stack : e}`)
          if (!res.headersSent) res.statusCode = 500
          res.end()
        }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Server-only secrets (GROQ_API_KEY, DATA_GOV_SG_API_KEY) from
  // .env.local, exposed to the dev function but never to the browser bundle.
  const env = loadEnv(mode, process.cwd(), '')
  for (const key of ['GROQ_API_KEY', 'GROQ_MODEL', 'DATA_GOV_SG_API_KEY']) {
    if (env[key] && !process.env[key]) process.env[key] = env[key]
  }
  return {
    plugins: [react(), companionDevApi()],
    // MapLibre's tile worker is an ES module.
    worker: { format: 'es' },
    server: { proxy: mssProxy },
    preview: { proxy: mssProxy },
  }
})
