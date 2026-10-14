// Compila src/app.jsx y lo incrusta en index.html (un solo archivo, listo para GitHub Pages).
//   node build.mjs           → build único
//   node build.mjs --watch   → recompila al guardar
//   node build.mjs --serve   → recompila al guardar y sirve en http://localhost:8080
import * as esbuild from 'esbuild';
import {readFile, writeFile} from 'node:fs/promises';
import http from 'node:http';

const watch = process.argv.includes('--watch') || process.argv.includes('--serve');
const serve = process.argv.includes('--serve');

const options = {
  entryPoints: ['src/app.jsx'],
  bundle: true,
  minify: true,
  write: false,
  format: 'iife',
  target: ['es2019', 'safari13'],
  jsx: 'automatic',
  define: {'process.env.NODE_ENV': '"production"'},
  legalComments: 'none',
  logLevel: 'info',
};

async function writeHtml(result) {
  if (result.errors.length) return;
  // Evita que un "</script" dentro del bundle cierre la etiqueta antes de tiempo
  const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const template = await readFile('src/index.template.html', 'utf8');
  // Función como reemplazo para que los "$" del bundle no se interpreten
  const html = template.replace('<!--APP_SCRIPT-->', () => `<script>${js}</script>`);
  await writeFile('index.html', html);
  console.log(`index.html escrito (${(html.length / 1024).toFixed(0)} KB)`);
}

const plugin = {name: 'html', setup(b) { b.onEnd(writeHtml); }};

if (watch) {
  const ctx = await esbuild.context({...options, plugins: [plugin]});
  await ctx.watch();
  if (serve) {
    http.createServer(async (req, res) => {
      try {
        res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
        res.end(await readFile('index.html'));
      } catch { res.writeHead(500); res.end('index.html aún no existe'); }
    }).listen(8080, () => console.log('Sirviendo en http://localhost:8080'));
  }
} else {
  await writeHtml(await esbuild.build(options));
}
