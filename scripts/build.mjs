import { cp, mkdir, writeFile } from 'node:fs/promises';

const output = new URL('../dist/', import.meta.url);
await mkdir(output, { recursive: true });
for (const file of ['app.mjs', 'server.mjs', 'public']) {
  await cp(new URL('../' + file, import.meta.url), new URL(file, output), { recursive: true });
}
await writeFile(new URL('package.json', output), JSON.stringify({
  name: 'hoe', version: '0.1.0', private: true, type: 'module',
  engines: { node: '>=22' }, main: 'server.mjs',
  scripts: { start: 'node server.mjs' }
}, null, 2) + '\n');
console.log('Built HOE into dist/');
