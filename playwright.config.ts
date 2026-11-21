import {defineConfig} from '@playwright/test';
// E2E_PORT lets two worktrees run their suites at once; vite's strictPort and reuseExistingServer:false make a busy port fail instead of testing another tree.
const port=process.env.E2E_PORT||'1420',url=`http://127.0.0.1:${port}`;
export default defineConfig({testDir:'./e2e',use:{baseURL:url,viewport:{width:1440,height:1000},headless:true},webServer:{command:`npm run dev -- --port ${port}`,url,reuseExistingServer:false},reporter:'list'});
