import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Mirrors reference/IRIS-PAYROLL-main/vite.config.ts (port 3000, host 0.0.0.0,
// react plugin, '@' alias). The `define: process.env.API_KEY` block is
// deliberately NOT carried over: it inlined the AI provider key into the client
// bundle, which docs/13_SECURITY_AND_PRIVACY.md prohibits. KAREN calls its
// provider from an Edge Function instead. See ADR-004.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', 'VITE_');
  return {
    server: {
      port: 3000,
      host: '0.0.0.0',
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    define: {
      __KAREN_ENV__: JSON.stringify(env.VITE_APP_ENV ?? mode),
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./tests/setup.ts'],
      include: ['tests/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    },
  };
});
