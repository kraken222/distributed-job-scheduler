import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Same-origin API calls in dev; the token still travels in the header.
      '/api': 'http://localhost:4000',
    },
  },
});
