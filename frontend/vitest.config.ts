import { defineConfig } from 'vitest/config'

// happy-dom gives the tests a `window.location` (the signaling URL derives from the
// page origin) and a DOM for component-level tests.
export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
