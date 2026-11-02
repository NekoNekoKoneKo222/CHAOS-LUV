import { defineConfig } from 'vite';
export default defineConfig({
  server: { host: '0.0.0.0', port: 5173, proxy: { '/socket': { target: 'ws://localhost:3000', ws: true } } },
  build: { target: 'es2020' }
});
