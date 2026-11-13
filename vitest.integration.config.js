import { defineConfig } from 'vitest/config';

// Live-database tests. These read .env and talk to the real Supabase project
// (some with the service-role key). Never part of the default `npm test`.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.js'],
    include: ['tests/integration/**/*.test.js', 'tests/specs/**/*.spec.js'],
    exclude: ['**/node_modules/**', '.worktrees/**', '.claude/**']
  }
});
