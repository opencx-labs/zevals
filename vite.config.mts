import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => ({
  test: {
    projects: ['.'],
    globals: true,
    environment: 'node',
    // Vitest 4 no longer excludes dist by default; compiled specs would run alongside their sources
    exclude: ['**/node_modules/**', '**/.git/**', '**/dist/**'],
    env: {
      ...loadEnv(mode, process.cwd(), ''), // Loads all .env variables
    },
  },
}));
