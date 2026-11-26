// Builds audio_env.json: per-clip loudness envelope (24 fps) used to drive mouth movement.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const LEAD = 0.6, GAP = 0.5, FPS = 24;
const durs = [5.23, 3.25, 5.01, 3.55];
const offsets = []; let o = LEAD; for (const d of durs) { offsets.push(+o.toFixed(3)); o += d + GAP; }
const env = [];
for (let i = 0; i < 4; i++) {
  const buf = execFileSync('ffmpeg', ['-v','error','-i',`audio/line${i+1}.wav`,'-ac','1','-ar','8000','-f','f32le','-'], { maxBuffer: 1<<26 });
  const f = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength/4);
  const win = 8000/FPS, n = Math.ceil(f.length/win), r = [];
  for (let k = 0; k < n; k++) { let s=0,c=0; for (let j=Math.floor(k*win); j<Math.min(f.length,Math.floor((k+1)*win)); j++){ s+=f[j]*f[j]; c++; } r.push(Math.sqrt(s/Math.max(c,1))); }
  const mx = Math.max(...r); const e = r.map(v => Math.min(1, Math.pow(v/mx, 0.7)*1.15));
  const sm = e.map((v,k)=> 0.5*v + 0.25*(e[k-1]??v) + 0.25*(e[k+1]??v));
  env.push(sm.map(v=>+v.toFixed(3)));
}
const total = offsets[3] + durs[3] + 1.2;
writeFileSync('audio_env.json', JSON.stringify({ fps: FPS, offsets, durs, total, env }));
console.log('offsets', offsets, 'total', total.toFixed(2), 'frames@24', Math.ceil(total*24), 'env lens', env.map(e=>e.length));
