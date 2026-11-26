import {defineConfig} from '@playwright/test';
// E2E_PORT lets two worktrees run their suites at once; vite's strictPort and reuseExistingServer:false make a busy port fail instead of testing another tree.
const port=process.env.E2E_PORT||'1420',url=`http://127.0.0.1:${port}`;
export default defineConfig({testDir:'./e2e',use:{baseURL:url,viewport:{width:1440,height:1000},headless:true},webServer:{command:`npm run dev -- --port ${port}`,url,reuseExistingServer:false},
// The perf budget runs alone, after every other test, so no other worker competes for the CPU; a file filter alone still pulls in the whole 'main' project, so run the perf file with `--no-deps`.
projects:[{name:'main',testIgnore:/perf-budget/},{name:'perf',testMatch:/perf-budget/,dependencies:['main']}],reporter:'list'});
