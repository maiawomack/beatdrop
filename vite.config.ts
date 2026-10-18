import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { audioLibrary } from './server/audioLibrary';

export default defineConfig({
  plugins: [
    react(),
    audioLibrary({
      libraryDir: fileURLToPath(new URL('./mp3', import.meta.url)),
      // Stems are committed next to the songs (tools/stems/sync_library.py keeps them in sync).
      stemsDir: fileURLToPath(new URL('./mp3/.stems', import.meta.url)),
    }),
  ],
  build: {
    rollupOptions: {
      // Pages: the decks interface (Monitor 1), the spatial workstation (Monitor 2),
      // and Task 1's engine harness.
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        spatial: fileURLToPath(new URL('./spatial.html', import.meta.url)),
        harness: fileURLToPath(new URL('./harness.html', import.meta.url)),
      },
    },
  },
  server: { host: '127.0.0.1', port: 5173 },
  preview: { host: '127.0.0.1', port: 5173 },
});
