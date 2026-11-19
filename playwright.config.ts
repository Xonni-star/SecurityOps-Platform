import {defineConfig,devices} from '@playwright/test';

export default defineConfig({
  testDir:'./e2e',
  fullyParallel:false,
  retries:process.env.CI?2:0,
  reporter:[['list'],['html',{open:'never'}]],
  use:{baseURL:'http://localhost:5173',trace:'on-first-retry',screenshot:'only-on-failure'},
  webServer:[
    {command:'npm run dev -w backend',url:'http://localhost:3000/health',reuseExistingServer:!process.env.CI,timeout:120000},
    {command:'npm run dev -w frontend -- --host 127.0.0.1',url:'http://localhost:5173',reuseExistingServer:!process.env.CI,timeout:120000},
  ],
  projects:[{name:'chromium',use:{...devices['Desktop Chrome']}}],
});
