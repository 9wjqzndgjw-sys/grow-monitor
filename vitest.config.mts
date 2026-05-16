import { defineConfig } from 'vitest/config'

// Standalone config so vitest doesn't load vite.config.ts (which pulls in
// the ESM-only React plugin). The pid library tests are pure TS — no JSX.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
