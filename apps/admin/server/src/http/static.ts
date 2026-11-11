import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import type { Logger } from '../log.js'
import { BASE, type App } from './app.js'

// Serves the built web console under /admin. Vite fingerprints everything in
// assets/, so those are cached forever; index.html is never cached, which is
// what lets a deploy take effect on the next page load.

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
}

export function staticRoutes(app: App, staticDir: string, log: Logger) {
  const root = resolve(staticDir)
  const indexPath = join(root, 'index.html')
  if (!existsSync(indexPath)) {
    log.warn({ component: 'http', static_dir: root }, 'web console build not found; only the API will be served')
  }
  // Read once: the file only changes with a new image.
  const index = existsSync(indexPath) ? readFileSync(indexPath) : null

  const sendIndex = () =>
    index
      ? new Response(index, { headers: { 'Content-Type': TYPES['.html']!, 'Cache-Control': 'no-cache' } })
      : new Response('The web console has not been built into this image.', { status: 503 })

  app.get(BASE, (c) => c.redirect(`${BASE}/`, 308))

  app.get(`${BASE}/*`, (c) => {
    const relative = decodeURIComponent(c.req.path.slice(BASE.length + 1))
    // API and hook paths that reach here did not match a route.
    if (relative.startsWith('api/') || relative.startsWith('hooks/')) {
      return c.json({ error: { code: 'not_found', message: 'No such endpoint.' } }, 404)
    }
    if (relative === '' || !extname(relative)) return sendIndex()

    const file = normalize(join(root, relative))
    // Refuse anything that resolves outside the build directory.
    if (file !== root && !file.startsWith(root + sep)) return c.body(null, 404)
    if (!existsSync(file) || !statSync(file).isFile()) return c.body(null, 404)

    const immutable = relative.startsWith('assets/')
    return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, {
      headers: {
        'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': String(statSync(file).size),
        'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      },
    })
  })
}
