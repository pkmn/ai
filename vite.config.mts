import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    watch: false,
    globals: true,
    include: ['test/**/*.test.ts'],
    exclude: ['**/node_modules', 'build', 'public'],
  }
});
