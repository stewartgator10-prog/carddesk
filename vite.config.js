import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// Each build gets an id. The page knows its own; /version.json has the newest one, so a tab that
// was left open across an update can tell and offer a reload.
const BUILD_ID = process.env.COMMIT_REF?.slice(0, 12) || Date.now().toString(36)

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), 'VITE_'), ...process.env }
  const tyche = env.VITE_BRAND === 'tyche'
  return {
    define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
    plugins: [
      react(),
      {
        name: 'carddesk-version',
        apply: 'build',
        generateBundle() { this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD_ID }) }) },
      },
      {
        // The Tyche Cards build gets its own name, icon and description in the page head.
        name: 'brand-head',
        transformIndexHtml(html) {
          if (!tyche) return html
          return html
            .replace('<title>CardDesk</title>', '<title>Tyche Cards · Snap, price and list trading cards on eBay</title>')
            .replace('href="/favicon.svg"', 'href="/tyche-mark.svg"')
            .replace(/<meta name="description"[^>]*>/, '<meta name="description" content="Snap a stack of trading cards. Tyche Cards identifies and prices each one, cleans up the photo and lists it on eBay, then keeps your prices sharp and shows the profit on every card." />')
            .replace('content="#bfe4f4"', 'content="#1d3461"')
            .replace('background: #f1f5e2;', 'background: #f6f1e6;')
        },
      },
    ],
  }
})
