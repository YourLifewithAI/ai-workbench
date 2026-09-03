import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: 'src/ui',
  plugins: [react(), tailwindcss()],
  build: { outDir: '../../dist/ui', emptyOutDir: true, sourcemap: false },
  server: { port: 5173, strictPort: false },
});
