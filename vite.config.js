// Vite 配置：前端源码在 src/web/frontend/，构建产物输出到 src/web/public/。
// server.js 只服务 public/（静态 + /api），对构建工具零感知——发布产物与开发模式共用同一入口。
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/web/frontend',
  plugins: [react()],
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
  server: {
    port: 5180,
    proxy: {
      '/api': 'http://127.0.0.1:7800',
    },
  },
});
