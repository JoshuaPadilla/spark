import { devtools } from '@tanstack/devtools-vite'
import { defineConfig } from 'vite'

import { tanstackRouter } from '@tanstack/router-plugin/vite'

import tailwindcss from '@tailwindcss/vite'
import viteReact from '@vitejs/plugin-react'

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    devtools(),
    tailwindcss(),
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    viteReact(),
  ],
  server: {
    host: '0.0.0.0', // CRITICAL: Allows the VPS to accept outside connections
    port: 3000, // Make sure this matches the port you're trying to open
    strictPort: true, // Prevents Vite from switching to 3001 if 3000 is busy
  },
})

export default config
