import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@core': resolve(__dirname, './src/core'),
      '@react': resolve(__dirname, './src/react'),
    },
  },
  root: '.',
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})
