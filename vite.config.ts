import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
// The bundled runtime and Rust target hold thousands of files; watching them stalls the dev server.
export default defineConfig({plugins:[react()],server:{port:1420,strictPort:true,watch:{ignored:['**/runtime/**','**/src-tauri/**','**/.claude/**','**/release/**']}},clearScreen:false});
