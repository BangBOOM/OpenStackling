import { environmentFingerprint } from './src/runtime/provenance.js';
import { defineConfig } from 'vite';
import { runtimeHostPlugin } from './src/runtime/host/vite.js';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from './src/runtime/config.js';
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss(), runtimeHostPlugin()],
  define: {
    __STACKLING_CONFIG__: JSON.stringify(resolveConfig()),
    __STACKLING_ENVIRONMENT__: JSON.stringify(await environmentFingerprint()),
  },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: {
    target: 'es2022',
    rolldownOptions: {
      input: { main: 'index.html', worker: 'worker.html' },
      output: {
        codeSplitting: {
          groups: [
            { name: 'three-core', test: /\/three\/build\/three\.core\.js$/ },
            { name: 'three-webgl', test: /\/three\/build\/three\.module\.js$/ },
            { name: 'react-dom', test: /\/node_modules\/react-dom\// },
          ],
        },
      },
    },
  },
  worker: { format: 'es' as const },
}));
