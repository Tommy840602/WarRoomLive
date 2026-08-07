import { defineConfig } from 'vitest/config'

// jsdom gives the tests a `window.location` (the signaling URL derives from the
// page origin) and a DOM for component-level tests.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
