/* XIT DOMINÓ — utilitários de teste: gera cenas sintéticas de dominós (sem câmera). */
const LO = 0.25, MID = 0.5, HI = 0.75;
const LAYOUT = {
  0: [], 1: [[MID, MID]], 2: [[LO, LO], [HI, HI]], 3: [[LO, LO], [MID, MID], [HI, HI]],
  4: [[LO, LO], [HI, LO], [LO, HI], [HI, HI]], 5: [[LO, LO], [HI, LO], [LO, HI], [HI, HI], [MID, MID]],
  6: [[LO, LO], [LO, MID], [LO, HI], [HI, LO], [HI, MID], [HI, HI]],
};

export function mulberry(seed) { let t = seed; return () => { t += 0x6D2B79F5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; }; }

/**
 * tiles: [{cx, cy, angle, L, a, b}]  (a = metade u<0, b = metade u>0). W = L/2.
 * opts: {width,height,table:[r,g,b],tile:[r,g,b],pip:[r,g,b],noise,blur,seed,divider}
 */
export function renderScene(tiles, opts = {}) {
  const o = { width: 640, height: 480, table: [18, 70, 45], tile: [236, 230, 208], pip: [25, 25, 30], noise: 0, blur: 0, seed: 1, divider: true, ...opts };
  const { width: w, height: h } = o;
  const data = new Uint8ClampedArray(w * h * 4);
  const rnd = mulberry(o.seed);
  const prep = tiles.map((t) => ({ ...t, W: t.L / 2, cos: Math.cos(t.angle), sin: Math.sin(t.angle) }));
  const SS = 2;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy += 1) for (let sx = 0; sx < SS; sx += 1) {
        const px = x + (sx + 0.5) / SS, py = y + (sy + 0.5) / SS;
        let col = o.table;
        for (const t of prep) {
          const dx = px - t.cx, dy = py - t.cy;
          const u = dx * t.cos + dy * t.sin, v = -dx * t.sin + dy * t.cos;
          if (Math.abs(u) > t.L / 2 || Math.abs(v) > t.W / 2) continue;
          col = o.tile;
          const edge = Math.min(t.L / 2 - Math.abs(u), t.W / 2 - Math.abs(v));
          if (edge < 1.5) { col = [150, 145, 130]; }
          if (o.divider && Math.abs(u) < Math.max(0.9, t.L * 0.012)) col = o.pip;
          const half = u < 0 ? 0 : 1;
          const count = half === 0 ? t.a : t.b;
          const hu = half === 0 ? (u + t.L / 2) / (t.L / 2) : u / (t.L / 2);
          const hv = (v + t.W / 2) / t.W;
          const rad = t.W * 0.085;
          for (const [lx, ly] of LAYOUT[count]) {
            const pxu = lx * (t.L / 2), pyv = ly * t.W;
            if (Math.hypot(hu * (t.L / 2) - pxu, hv * t.W - pyv) <= rad) col = o.pip;
          }
        }
        r += col[0]; g += col[1]; b += col[2];
      }
      const i = (y * w + x) * 4;
      data[i] = r / (SS * SS); data[i + 1] = g / (SS * SS); data[i + 2] = b / (SS * SS); data[i + 3] = 255;
    }
  }
  let out = { data, width: w, height: h };
  if (o.blur > 0) out = boxBlur(out, o.blur);
  if (o.noise > 0) {
    for (let i = 0; i < out.data.length; i += 4) {
      const n = (rnd() + rnd() + rnd() - 1.5) * o.noise * 2;
      out.data[i] += n; out.data[i + 1] += n; out.data[i + 2] += n;
    }
  }
  return out;
}

function boxBlur(frame, r) {
  const { data, width: w, height: h } = frame;
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    let s0 = 0, s1 = 0, s2 = 0, n = 0;
    for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy += 1) for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx += 1) {
      const i = (yy * w + xx) * 4; s0 += data[i]; s1 += data[i + 1]; s2 += data[i + 2]; n += 1;
    }
    const i = (y * w + x) * 4; out[i] = s0 / n; out[i + 1] = s1 / n; out[i + 2] = s2 / n; out[i + 3] = 255;
  }
  return { data: out, width: w, height: h };
}

export function toPNG(frame) { // só para inspeção manual (PPM)
  const { data, width: w, height: h } = frame;
  let s = `P6\n${w} ${h}\n255\n`;
  const buf = Buffer.alloc(s.length + w * h * 3); buf.write(s);
  let o = s.length; for (let i = 0; i < w * h; i += 1) { buf[o++] = data[i * 4]; buf[o++] = data[i * 4 + 1]; buf[o++] = data[i * 4 + 2]; }
  return buf;
}
