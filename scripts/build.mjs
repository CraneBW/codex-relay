import { build } from 'esbuild';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
await mkdir('dist', { recursive: true });
const server = await build({ entryPoints: ['src/server.mjs'], bundle: true, platform: 'node', format: 'cjs',
  target: 'node22', outfile: 'dist/server.cjs', minify: true, legalComments: 'eof', metafile: true });
const ui = await build({ entryPoints: ['src/board.mjs'], bundle: true, platform: 'browser',
  target: 'es2022', format: 'iife', outdir: 'dist', write: false, minify: true, legalComments: 'eof', metafile: true,
  loader: { '.woff2': 'dataurl' } });
const html = await readFile('src/board.html', 'utf8');
const css = ui.outputFiles.find(file => file.path.endsWith('.css')).text;
const js = ui.outputFiles.find(file => file.path.endsWith('.js')).text;
await writeFile('dist/board.html', html
  .replace('<!-- styles -->', () => '<style>' + css.replace(/<\/style/gi, '<\\/style') + '</style>')
  .replace('<!-- application -->', () => '<script>' + js.replace(/<\/script/gi, '<\\/script') + '</script>'));

const bundled = new Set();
for (const { metafile } of [server, ui]) {
  for (const f of Object.keys(metafile.inputs)) {
    const match = f.match(/^(.*node_modules\/)((?:@[^/]+\/)?[^/]+)/);
    if (match) bundled.add(match[0]);
  }
}
const notices = [];
for (const dir of [...bundled].sort()) {
  const pkg = JSON.parse(await readFile(dir + '/package.json', 'utf8'));
  const files = (await readdir(dir)).filter(f => /^(license|licence|copying|notice)([.-].*)?$/i.test(f));
  const texts = await Promise.all(files.map(f => readFile(dir + '/' + f, 'utf8')));
  notices.push(pkg.name + ' ' + pkg.version + ' · ' + (pkg.license || '') + '\n' + texts.join('\n'));
}
await writeFile('dist/THIRD-PARTY-NOTICES.txt', notices.join('\n\n'));
