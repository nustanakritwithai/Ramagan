import {defineConfig} from 'vite';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('.',import.meta.url));
export default defineConfig({
  root,
  base:'./',
  envDir:false,
  build:{
    outDir:resolve(root,'dist-test'),
    rollupOptions:{input:resolve(root,'index.test.html')}
  }
});
