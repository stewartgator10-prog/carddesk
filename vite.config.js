import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Each build gets an id. The page knows its own; /version.json has the newest one, so a tab that
// was left open across an update can tell and offer a reload.
const BUILD_ID = process.env.COMMIT_REF?.slice(0, 12) || Date.now().toString(36)

export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  plugins: [
    react(),
    {
      name: 'carddesk-version',
      apply: 'build',
      generateBundle() { this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD_ID }) }) },
    },
  ],
})
