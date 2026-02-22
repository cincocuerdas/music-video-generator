import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const backendProxyTarget = env.VITE_BACKEND_PROXY_TARGET || 'http://127.0.0.1:3000'
  const apiProxyTarget = env.VITE_API_PROXY_TARGET || backendProxyTarget
  const outputProxyTarget = env.VITE_OUTPUT_PROXY_TARGET || backendProxyTarget
  const socketProxyTarget = env.VITE_SOCKET_PROXY_TARGET || backendProxyTarget

  return {
    plugins: [react()],
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: './src/test/setup.ts',
      css: true,
      include: ['src/**/*.{test,spec}.{ts,tsx}'],
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules') && !id.includes('/src/services/')) {
              return undefined;
            }

            if (
              id.includes('/node_modules/react/') ||
              id.includes('/node_modules/react-router/') ||
              id.includes('/node_modules/react-router-dom/')
            ) {
              return 'vendor-react';
            }

            if (
              id.includes('/node_modules/react-dom/') ||
              id.includes('/node_modules/scheduler/')
            ) {
              return 'vendor-react-dom';
            }

            if (id.includes('/node_modules/framer-motion/')) {
              return 'vendor-motion';
            }

            if (id.includes('/node_modules/lucide-react/')) {
              return 'vendor-icons';
            }

            if (id.includes('/node_modules/axios/')) {
              return 'vendor-axios';
            }

            if (id.includes('/src/services/')) {
              return 'app-services';
            }

            return undefined;
          },
        },
      },
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    server: {
      proxy: {
        '/api': {
          target: apiProxyTarget,
          changeOrigin: true,
        },
        '/output': {
          target: outputProxyTarget,
          changeOrigin: true,
        },
        '/socket.io': {
          target: socketProxyTarget,
          ws: true,
        },
      }
    }
  }
})

