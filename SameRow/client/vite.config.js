import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react()
  ],
  server: {
    host: true, // Expose to network
    headers: { 'Permissions-Policy': 'picture-in-picture=()' },
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true,
        changeOrigin: true
      },
      '/api': 'http://localhost:3000'
    }
  },
  preview: {
    headers: { 'Permissions-Policy': 'picture-in-picture=()' }
  }
})
