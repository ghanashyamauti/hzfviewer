import { defineConfig, loadEnv } from 'vite';
import fs from 'fs';
import path from 'path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    server: {
      port: parseInt(env.PORT || '5173', 10),
      open: false,
    },
    plugins: [
      {
        name: 'copy-static-assets',
        closeBundle() {
          const files = ['app.js', 'config.js', 'jspdf.umd.min.js', 'styles.css', '.env'];
          for (const f of files) {
            const src = path.resolve(__dirname, f);
            const dest = path.resolve(__dirname, 'dist', f);
            if (fs.existsSync(src)) {
              fs.copyFileSync(src, dest);
            }
          }
        }
      }
    ],
    build: {
      outDir: 'dist',
    }
  };
});
