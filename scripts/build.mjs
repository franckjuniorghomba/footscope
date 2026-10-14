import { build } from 'esbuild';
import { mkdir, readFile, readdir, writeFile, rm, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
await rm(resolve(root, 'dist'), { recursive: true, force: true });
await mkdir(resolve(root, '.build'), { recursive: true });
await mkdir(resolve(root, 'dist/.openai'), { recursive: true });
const [page, css, clientScript] = await Promise.all(
  ['index.html', 'styles.css', 'app.js'].map((name) =>
    readFile(resolve(root, 'src/web', name), 'utf8'),
  ),
);
// Polices WOFF2 auto-hébergées (src/web/fonts), intégrées en base64 et servies par le Worker.
const fontDir = resolve(root, 'src/web/fonts');
const fonts = {};
for (const name of (await readdir(fontDir)).filter((f) => f.endsWith('.woff2')).sort())
  fonts[name] = (await readFile(resolve(fontDir, name))).toString('base64');
await writeFile(
  resolve(root, '.build/web-assets.js'),
  Object.entries({ page, css, clientScript, fonts })
    .map(([name, value]) => `export const ${name} = ${JSON.stringify(value)};`)
    .join('\n') + '\n',
);
await build({
  entryPoints: [resolve(root, 'worker/index.js')],
  outfile: resolve(root, 'dist/server/index.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: false,
  logLevel: 'warning',
});
await copyFile(resolve(root, '.openai/hosting.json'), resolve(root, 'dist/.openai/hosting.json'));
console.log('Built modular Worker and web assets.');
