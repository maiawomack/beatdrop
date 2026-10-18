import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { audioLibrary } from './server/audioLibrary';

export default defineConfig({
  plugins: [
    audioLibrary({
      libraryDir: fileURLToPath(new URL('./mp3', import.meta.url)),
      stemsDir: fileURLToPath(new URL('./public/stems', import.meta.url)),
    }),
  ],
  server: { host: '127.0.0.1', port: 5173 },
  preview: { host: '127.0.0.1', port: 5173 },
});
