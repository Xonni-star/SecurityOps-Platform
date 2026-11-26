import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins:[react()],
  server:{port:5173, proxy:{'/api':process.env.VITE_API_PROXY_TARGET??process.env.API_PROXY_TARGET??'http://localhost:3000'}},
  build:{
    rollupOptions:{
      output:{
        manualChunks(id){
          if(!id.includes('node_modules'))return undefined;
          if(id.includes('/leaflet/')||id.includes('/react-leaflet/')||id.includes('/@react-leaflet/'))return 'maps';
          if(id.includes('/react-router/')||id.includes('/react-router-dom/'))return 'router';
          if(id.includes('/react-dom/')||id.includes('/react/')||id.includes('/scheduler/'))return 'react';
          return undefined;
        },
      },
    },
  },
});
