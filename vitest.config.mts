import { defineConfig } from 'vitest/config'

// Nothing here measured coverage, and the two files that carried the real risk
// — the orchestration in index.ts and the egress/credential transport in
// callback.ts — were at 0% for most of this action's life. `include` covers all
// of src/ rather than only the files a test happens to import, so a new module
// that nothing exercises lowers the number instead of being invisible.
//
// Thresholds sit just under the current figures: they catch a regression rather
// than describing today, and they only ever move up.
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        statements: 96,
        branches: 93,
        functions: 100,
        lines: 96,
      },
    },
  },
})
