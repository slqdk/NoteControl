import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // Proxy API calls to the ASP.NET Core backend during development.
      // In production the backend serves the built frontend as static files.
      '/health': 'http://127.0.0.1:8080',
      '/api':    'http://127.0.0.1:8080'
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: true
  }
});
