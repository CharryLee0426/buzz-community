import { fileURLToPath } from 'node:url'
import stylexImport from '@stylexjs/unplugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type PluginOption } from 'vite'

const rootDir = fileURLToPath(new URL('.', import.meta.url))

// `pnpm dev` talks to a console server on this machine. ADMIN_API_TARGET points
// it at another one, such as a deployed community (https://buzz.example.com);
// the Origin header is rewritten so that console's CSRF check passes. Signing
// in that way depends on the browser keeping a `__Secure-` cookie on a plain
// http origin, which not every browser does.
const apiTarget = process.env.ADMIN_API_TARGET ?? 'http://127.0.0.1:8787'
const isRemoteApi = !/^http:\/\/(127\.0\.0\.1|localhost)[:/]?/.test(apiTarget)

// @stylexjs/unplugin types its CommonJS build, so under ESM resolution the
// default import is typed as a namespace although it is the plugin factory.
const stylex = ((stylexImport as unknown as { default?: unknown }).default ??
  stylexImport) as (options: Record<string, unknown>) => PluginOption

// The console is served under /admin by the gateway, so every asset URL and
// the client router share that prefix. The API lives at /admin/api.
export default defineConfig(({ mode }) => ({
  base: '/admin/',
  plugins: [
    // StyleX compiles this app's own styles only. Astryx components come
    // prebuilt in astryx.css and must stay out of the compiler's inputs.
    stylex({
      dev: mode !== 'production',
      runtimeInjection: false,
      treeshakeCompensation: true,
      unstable_moduleResolution: { type: 'commonJS', rootDir },
    }),
    react(),
  ],
  resolve: {
    alias: {
      // Self-hosted fonts in place of the theme's Google Fonts import.
      '@astryxdesign/theme-neutral/fonts.css': fileURLToPath(new URL('./src/styles/fonts.css', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/admin/api': {
        target: apiTarget,
        changeOrigin: isRemoteApi,
        headers: isRemoteApi ? { origin: new URL(apiTarget).origin } : undefined,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 900,
  },
}))
