// Usage: node render.mjs --out frames --w 1280 --h 720 --fps 24 --from 0 --to 489
//        node render.mjs --still 3.0,8.0 --out stills --w 960 --h 540
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node-tools/node_modules/playwright');

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]] : a, []));
const W = +args.w || 1280, H = +args.h || 720, FPS = +args.fps || 24;
const outDir = args.out || 'frames';
fs.mkdirSync(outDir, { recursive: true });

const root = path.resolve('.');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': mime[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise(r => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log('[page]', m.text().slice(0, 400)); });
page.on('pageerror', e => console.log('[pageerror]', e.message.slice(0, 600)));
await page.goto(`http://localhost:${port}/index.html?w=${W}&h=${H}`);
await page.waitForFunction('window.__ready === true', null, { timeout: 120000 });

async function grab(file, t, n, fmt) {
  await page.evaluate(([t, n]) => window.renderAt(t, n), [t, n]);
  const data = await page.evaluate((fmt) => document.getElementById('c').toDataURL(fmt === 'png' ? 'image/png' : 'image/jpeg', 0.95), fmt);
  fs.writeFileSync(file, Buffer.from(data.split(',')[1], 'base64'));
}
const t00 = Date.now();
if (args.still) {
  for (const s of String(args.still).split(',')) { const t = +s; const t0 = Date.now(); await grab(path.join(outDir, `still_${t.toFixed(2)}.png`), t, 0, 'png'); console.log(`still t=${t} ${(Date.now() - t0) / 1000}s`); }
} else {
  const from = +args.from || 0, to = +args.to;
  const step = +args.step || 1;
  for (let f = from; f < to; f += step) {
    const t0 = Date.now();
    await grab(path.join(outDir, `f_${String(f).padStart(5, '0')}.jpg`), f / FPS, f, 'jpg');
    if ((f - from) % 10 === 0) console.log(`frame ${f}/${to} ${(Date.now() - t0) / 1000}s  elapsed ${((Date.now() - t00) / 1000).toFixed(0)}s`);
  }
}
await browser.close(); server.close();
