import { defineConfig } from 'vite';
import { resolve } from 'path';

/**
 * Separate Vite config for AudioWorklet files.
 * Worklets must be bundled as IIFE modules (no import/export)
 * because AudioWorklet.addModule() expects a self-contained script.
 * Uses VITE_ENTRY env var to select which worklet to build.
 */
const entryName = process.env.VITE_ENTRY || 'pitch-processor';
const entries: Record<string, string> = {
  'pitch-processor': resolve(__dirname, 'src/worklets/pitch-processor.ts'),
  'bpm-processor': resolve(__dirname, 'src/worklets/bpm-processor.ts'),
  'key-processor': resolve(__dirname, 'src/worklets/key-processor.ts'),
  'capture-processor': resolve(__dirname, 'src/worklets/capture-processor.ts'),
};

export default defineConfig({
  build: {
    outDir: 'dist/worklets',
    emptyOutDir: entryName === 'pitch-processor',
    rollupOptions: {
      input: entries[entryName],
      output: {
        entryFileNames: `${entryName}.js`,
        format: 'iife' as const,
      },
    },
    minify: false,
  },
});
