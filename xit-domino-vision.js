/* ==========================================================================
 * XIT DOMINÓ — xit-domino-vision.js
 * Visão computacional tradicional em JavaScript puro (sem OpenCV.js, sem IA).
 * Trabalha sobre { data: RGBA, width, height } (o mesmo formato do ImageData),
 * por isso roda no navegador e também em testes no Node.
 *
 * Pipeline:
 *  1. Tons de cinza, redução de tamanho (economia de memória/CPU no celular).
 *  2. Limiarização de Otsu (superfície clara das peças x mesa) e fechamento
 *     morfológico para preencher a divisória central e os pontos.
 *  3. Componentes conectados -> retângulos orientados (momentos de imagem).
 *  4. Filtro de formato (proporção ~2:1, preenchimento) e separação de blocos
 *     de várias peças alinhadas.
 *  5. Correção de perspectiva/rotação por peça (reamostragem afim 128x64 a
 *     partir da imagem em resolução total).
 *  6. Divisória central, pontos (círculos) em cada metade, validação do
 *     padrão do dominó e confiança.
 *
 * Limites honestos: peças amontoadas, curvas da cadeia que formam blocos
 * não retangulares, reflexos fortes e baixa resolução reduzem a confiança.
 * Nesses casos o módulo devolve baixa confiança (nunca inventa números) e o
 * restante do app pede confirmação ao usuário.
 * ========================================================================== */

export const DEFAULT_VISION = Object.freeze({
  analysisWidth: 480,
  tilePolarity: 'light',   // 'light' = peça clara com pontos escuros; 'dark' = o inverso
  thresholdOffset: 0,
  closeRadius: 1,          // fecha vãos escuros finos (divisória central, pontos) na máscara
  minTileAreaFrac: 0.0015, // área mínima da peça (fração da imagem analisada)
  maxTileAreaFrac: 0.12,
  minAspect: 1.5,
  maxAspect: 2.7,
  minFill: 0.62,
  warpW: 128,
  warpH: 64,
  maxPip: 6,
  tileWidth: 0,            // largura de uma peça em px (0 = estimar pelo quadro)
});

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* -------------------------------------------------------------------------
 * Imagem básica
 * ----------------------------------------------------------------------- */
export function toGray(frame) {
  const { data, width: w, height: h } = frame;
  const g = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; i < g.length; i += 1, p += 4) {
    g[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
  }
  return g;
}

/** Redução por média de blocos. Retorna a imagem e o fator de escala (novo/original). */
export function downscaleGray(gray, w, h, targetW) {
  if (w <= targetW) return { gray, w, h, scale: 1 };
  const scale = targetW / w;
  const nw = targetW;
  const nh = Math.max(1, Math.round(h * scale));
  const out = new Uint8ClampedArray(nw * nh);
  for (let y = 0; y < nh; y += 1) {
    const y0 = Math.floor(y / scale);
    const y1 = Math.min(h, Math.max(y0 + 1, Math.floor((y + 1) / scale)));
    for (let x = 0; x < nw; x += 1) {
      const x0 = Math.floor(x / scale);
      const x1 = Math.min(w, Math.max(x0 + 1, Math.floor((x + 1) / scale)));
      let sum = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy += 1) {
        const row = yy * w;
        for (let xx = x0; xx < x1; xx += 1) { sum += gray[row + xx]; n += 1; }
      }
      out[y * nw + x] = n ? sum / n : 0;
    }
  }
  return { gray: out, w: nw, h: nh, scale };
}

export function otsu(values) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < values.length; i += 1) hist[values[i] | 0] += 1;
  const total = values.length;
  let sum = 0;
  for (let t = 0; t < 256; t += 1) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let thr = 127;
  for (let t = 0; t < 256; t += 1) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

function percentile(values, p) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < values.length; i += 1) hist[values[i] | 0] += 1;
  const target = values.length * p;
  let acc = 0;
  for (let t = 0; t < 256; t += 1) {
    acc += hist[t];
    if (acc >= target) return t;
  }
  return 255;
}

/* -------------------------------------------------------------------------
 * Qualidade da imagem
 * ----------------------------------------------------------------------- */
export function frameQuality(gray, w, h) {
  let sum = 0;
  let sum2 = 0;
  const n = gray.length;
  for (let i = 0; i < n; i += 1) { sum += gray[i]; sum2 += gray[i] * gray[i]; }
  const brightness = sum / n;
  const contrast = Math.sqrt(Math.max(0, sum2 / n - brightness * brightness));

  // variância do Laplaciano = nitidez
  let lsum = 0;
  let lsum2 = 0;
  let count = 0;
  for (let y = 1; y < h - 1; y += 2) {
    for (let x = 1; x < w - 1; x += 2) {
      const i = y * w + x;
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
      lsum += lap; lsum2 += lap * lap; count += 1;
    }
  }
  const lmean = count ? lsum / count : 0;
  const sharpness = count ? lsum2 / count - lmean * lmean : 0;

  const hints = [];
  if (brightness < 60) hints.push('Pouca luz: acenda uma luz sobre a mesa.');
  if (brightness > 215) hints.push('Imagem estourada: evite reflexos e luz direta.');
  if (contrast < 28) hints.push('Pouco contraste entre as peças e a mesa.');
  if (sharpness < 40) hints.push('Imagem sem foco ou tremida: segure o aparelho firme.');

  const light = clamp(1 - Math.abs(brightness - 130) / 130, 0, 1);
  const score = clamp(0.35 * light + 0.3 * clamp(contrast / 60, 0, 1) + 0.35 * clamp(sharpness / 250, 0, 1), 0, 1);
  const label = score >= 0.62 ? 'boa' : score >= 0.38 ? 'média' : 'ruim';
  return { brightness, contrast, sharpness, score, label, hints };
}

/* -------------------------------------------------------------------------
 * Morfologia e componentes conectados
 * ----------------------------------------------------------------------- */
function dilateErodeSeparable(src, w, h, r, useMax) {
  const tmp = new Uint8ClampedArray(src.length);
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < h; y += 1) {
    const row = y * w;
    for (let x = 0; x < w; x += 1) {
      let v = src[row + x];
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w - 1, x + r);
      for (let xx = x0; xx <= x1; xx += 1) {
        const s = src[row + xx];
        if (useMax ? s > v : s < v) v = s;
      }
      tmp[row + x] = v;
    }
  }
  for (let y = 0; y < h; y += 1) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x += 1) {
      let v = tmp[y * w + x];
      for (let yy = y0; yy <= y1; yy += 1) {
        const s = tmp[yy * w + x];
        if (useMax ? s > v : s < v) v = s;
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

/** Fechamento (dilata e erode) = preenche vales escuros finos. */
function closing(src, w, h, r) {
  return dilateErodeSeparable(dilateErodeSeparable(src, w, h, r, true), w, h, r, false);
}

export function labelComponents(mask, w, h) {
  const labels = new Int32Array(w * h);
  const comps = [];
  const stack = new Int32Array(w * h);
  let next = 0;
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || labels[start]) continue;
    next += 1;
    const c = { id: next, area: 0, minX: w, maxX: 0, minY: h, maxY: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0 };
    let sp = 0;
    stack[sp++] = start;
    labels[start] = next;
    while (sp > 0) {
      const p = stack[--sp];
      const x = p % w;
      const y = (p - x) / w;
      c.area += 1; c.sx += x; c.sy += y; c.sxx += x * x; c.syy += y * y; c.sxy += x * y;
      if (x < c.minX) c.minX = x;
      if (x > c.maxX) c.maxX = x;
      if (y < c.minY) c.minY = y;
      if (y > c.maxY) c.maxY = y;
      if (x > 0 && mask[p - 1] && !labels[p - 1]) { labels[p - 1] = next; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && !labels[p + 1]) { labels[p + 1] = next; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - w] && !labels[p - w]) { labels[p - w] = next; stack[sp++] = p - w; }
      if (y < h - 1 && mask[p + w] && !labels[p + w]) { labels[p + w] = next; stack[sp++] = p + w; }
    }
    comps.push(c);
  }
  return { labels, comps };
}

/* -------------------------------------------------------------------------
 * Retângulo orientado de um componente
 * ----------------------------------------------------------------------- */
function orientedBox(comp, labels, w) {
  const n = comp.area;
  const cx = comp.sx / n;
  const cy = comp.sy / n;
  const mu20 = comp.sxx / n - cx * cx;
  const mu02 = comp.syy / n - cy * cy;
  const mu11 = comp.sxy / n - cx * cy;
  let theta = 0.5 * Math.atan2(2 * mu11, mu20 - mu02);
  let cos = Math.cos(theta);
  let sin = Math.sin(theta);
  let umin = Infinity; let umax = -Infinity; let vmin = Infinity; let vmax = -Infinity;
  for (let y = comp.minY; y <= comp.maxY; y += 1) {
    for (let x = comp.minX; x <= comp.maxX; x += 1) {
      if (labels[y * w + x] !== comp.id) continue;
      const dx = x - cx;
      const dy = y - cy;
      const u = dx * cos + dy * sin;
      const v = -dx * sin + dy * cos;
      if (u < umin) umin = u;
      if (u > umax) umax = u;
      if (v < vmin) vmin = v;
      if (v > vmax) vmax = v;
    }
  }
  let L = umax - umin + 1;
  let W = vmax - vmin + 1;
  let uc = (umax + umin) / 2;
  let vc = (vmax + vmin) / 2;
  if (W > L) { // eixo maior sempre é "u"
    theta += Math.PI / 2;
    const c2 = Math.cos(theta);
    const s2 = Math.sin(theta);
    [L, W] = [W, L];
    // recalcula centro no novo referencial
    const ox = cos * uc - sin * vc;
    const oy = sin * uc + cos * vc;
    cos = c2; sin = s2;
    uc = ox * cos + oy * sin;
    vc = -ox * sin + oy * cos;
  }
  const centerX = cx + cos * uc - sin * vc;
  const centerY = cy + sin * uc + cos * vc;
  // normaliza ângulo para (-90°, 90°]
  let angle = theta;
  while (angle > Math.PI / 2) angle -= Math.PI;
  while (angle <= -Math.PI / 2) angle += Math.PI;
  return { cx: centerX, cy: centerY, angle, L, W, area: n };
}

/* -------------------------------------------------------------------------
 * Reamostragem da peça (corrige rotação e perspectiva local)
 * ----------------------------------------------------------------------- */
function warpTile(gray, w, h, tile, outW, outH) {
  const out = new Uint8ClampedArray(outW * outH);
  const cos = Math.cos(tile.angle);
  const sin = Math.sin(tile.angle);
  for (let j = 0; j < outH; j += 1) {
    const v = ((j + 0.5) / outH - 0.5) * tile.W;
    for (let i = 0; i < outW; i += 1) {
      const u = ((i + 0.5) / outW - 0.5) * tile.L;
      const x = tile.cx + u * cos - v * sin - 0.5;
      const y = tile.cy + u * sin + v * cos - 0.5;
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const fx = x - x0;
      const fy = y - y0;
      const xa = clamp(x0, 0, w - 1);
      const xb = clamp(x0 + 1, 0, w - 1);
      const ya = clamp(y0, 0, h - 1);
      const yb = clamp(y0 + 1, 0, h - 1);
      const top = gray[ya * w + xa] * (1 - fx) + gray[ya * w + xb] * fx;
      const bot = gray[yb * w + xa] * (1 - fx) + gray[yb * w + xb] * fx;
      out[j * outW + i] = top * (1 - fy) + bot * fy;
    }
  }
  return out;
}

/* -------------------------------------------------------------------------
 * Padrões de pontos (posições normalizadas dentro de cada metade, 0..1)
 * ----------------------------------------------------------------------- */
const LO = 0.25;
const MID = 0.5;
const HI = 0.75;
const PATTERNS = {
  1: [[[MID, MID]]],
  2: [[[LO, LO], [HI, HI]], [[LO, HI], [HI, LO]]],
  3: [[[LO, LO], [MID, MID], [HI, HI]], [[LO, HI], [MID, MID], [HI, LO]]],
  4: [[[LO, LO], [HI, LO], [LO, HI], [HI, HI]]],
  5: [[[LO, LO], [HI, LO], [LO, HI], [HI, HI], [MID, MID]]],
  6: [
    [[LO, LO], [LO, MID], [LO, HI], [HI, LO], [HI, MID], [HI, HI]],
    [[LO, LO], [MID, LO], [HI, LO], [LO, HI], [MID, HI], [HI, HI]],
  ],
};

function patternScore(points) {
  const n = points.length;
  const options = PATTERNS[n];
  if (!options) return n === 0 ? 1 : 0.6;
  let best = 0;
  for (const layout of options) {
    const used = new Array(layout.length).fill(false);
    let total = 0;
    for (const p of points) {
      let bi = -1;
      let bd = Infinity;
      for (let k = 0; k < layout.length; k += 1) {
        if (used[k]) continue;
        const d = Math.hypot(p.x - layout[k][0], p.y - layout[k][1]);
        if (d < bd) { bd = d; bi = k; }
      }
      used[bi] = true;
      total += bd;
    }
    const mean = total / n;
    best = Math.max(best, clamp(1 - mean / 0.28, 0, 1));
  }
  return best;
}

/* -------------------------------------------------------------------------
 * Leitura dos pontos de uma peça
 * ----------------------------------------------------------------------- */
export function readTile(gray, w, h, tile, opts = {}) {
  const o = { ...DEFAULT_VISION, ...opts };
  const W = o.warpW;
  const H = o.warpH;
  let img = warpTile(gray, w, h, tile, W, H);
  if (o.tilePolarity === 'dark') img = img.map((v) => 255 - v);

  // região interna (sem as bordas da peça)
  const x0 = Math.round(W * 0.06);
  const x1 = Math.round(W * 0.94);
  const y0 = Math.round(H * 0.08);
  const y1 = Math.round(H * 0.92);
  const inner = [];
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) inner.push(img[y * W + x]);
  const innerArr = Uint8ClampedArray.from(inner);
  const surface = percentile(innerArr, 0.6);
  const dark = percentile(innerArr, 0.02);
  const hasDark = dark < surface * 0.62;
  const threshold = (surface + dark) / 2;

  const mask = new Uint8Array(W * H);
  if (hasDark) {
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) mask[y * W + x] = img[y * W + x] < threshold ? 1 : 0;
    }
  }
  const { comps } = labelComponents(mask, W, H);

  const minArea = Math.max(8, 0.0015 * W * H);
  const maxArea = 0.05 * W * H;
  let dividerU = null;
  const pips = [];
  let noise = 0;
  for (const c of comps) {
    const bw = c.maxX - c.minX + 1;
    const bh = c.maxY - c.minY + 1;
    const isDivider = bh >= 0.5 * H && bw <= 0.16 * W;
    if (isDivider) { dividerU = (c.sx / c.area) / W; continue; }
    const aspect = bw / bh;
    const fill = c.area / (bw * bh);
    if (c.area >= minArea && c.area <= maxArea && aspect > 0.5 && aspect < 2 && fill > 0.5) {
      pips.push({ x: c.sx / c.area, y: c.sy / c.area, area: c.area });
    } else if (c.area >= 4) {
      noise += 1;
    }
  }

  const split = dividerU !== null ? dividerU * W : W / 2;
  const halves = [[], []];
  for (const p of pips) halves[p.x < split ? 0 : 1].push(p);

  const halfScore = halves.map((list, idx) => {
    const left = idx === 0 ? x0 : split + 2;
    const right = idx === 0 ? split - 2 : x1;
    const hw = Math.max(1, right - left);
    const hh = y1 - y0;
    const pts = list.map((p) => ({ x: (p.x - left) / hw, y: (p.y - y0) / hh }));
    let uniform = 1;
    if (list.length > 1) {
      const mean = list.reduce((a, p) => a + p.area, 0) / list.length;
      const sd = Math.sqrt(list.reduce((a, p) => a + (p.area - mean) ** 2, 0) / list.length);
      uniform = clamp(1 - (sd / mean - 0.25) / 0.5, 0.3, 1);
    }
    return { n: list.length, score: patternScore(pts) * uniform };
  });

  const counts = [halfScore[0].n, halfScore[1].n];
  let confidence = Math.min(halfScore[0].score, halfScore[1].score);
  if (counts.some((c) => c > o.maxPip)) confidence = 0;
  if (noise > 0) confidence *= clamp(1 - 0.12 * noise, 0.3, 1);
  if (dividerU === null) confidence = counts[0] + counts[1] === 0 ? 0 : confidence * 0.7;
  if (dividerU !== null && Math.abs(dividerU - 0.5) > 0.12) confidence *= 0.5;

  return {
    halves: confidence > 0 ? counts : null,
    counts,
    confidence: clamp(confidence, 0, 1),
    dividerFound: dividerU !== null,
    noise,
  };
}

/* -------------------------------------------------------------------------
 * Detecção de peças em um quadro
 * ----------------------------------------------------------------------- */
function buildTileMask(g, w, h, opts) {
  const bright = opts.tilePolarity === 'dark' ? g.map((v) => 255 - v) : g;
  const thr = clamp(otsu(bright) + opts.thresholdOffset, 1, 254);
  const raw = new Uint8ClampedArray(w * h);
  for (let i = 0; i < raw.length; i += 1) raw[i] = bright[i] > thr ? 255 : 0;
  const closed = closing(raw, w, h, opts.closeRadius);
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i += 1) mask[i] = closed[i] > 127 ? 1 : 0;
  return { mask, threshold: thr };
}

function median(list) {
  if (!list.length) return 0;
  const s = list.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * @param {{data:Uint8ClampedArray,width:number,height:number}} frame RGBA
 * @returns {{tiles:Array, quality:object, threshold:number, unresolved:number, width:number, height:number}}
 */
export function analyzeFrame(frame, options = {}) {
  const o = { ...DEFAULT_VISION, ...options };
  const fullW = frame.width;
  const fullH = frame.height;
  const fullGray = toGray(frame);
  const { gray: g, w, h, scale } = downscaleGray(fullGray, fullW, fullH, o.analysisWidth);
  const quality = frameQuality(g, w, h);
  const { mask, threshold } = buildTileMask(g, w, h, o);
  const { labels, comps } = labelComponents(mask, w, h);

  const minArea = o.minTileAreaFrac * w * h;
  const maxArea = o.maxTileAreaFrac * w * h;
  const boxes = [];
  for (const c of comps) {
    if (c.area < minArea || c.area > maxArea * 4) continue;
    const box = orientedBox(c, labels, w);
    box.clipped = c.minX <= 0 || c.minY <= 0 || c.maxX >= w - 1 || c.maxY >= h - 1;
    box.aspect = box.L / box.W;
    box.fill = c.area / (box.L * box.W);
    boxes.push(box);
  }

  // largura de referência de uma peça (para separar blocos com várias peças)
  const singles = boxes.filter((b) => b.aspect >= o.minAspect && b.aspect <= 2.4 && b.fill >= o.minFill && !b.clipped);
  const refW = o.tileWidth > 0 ? o.tileWidth * scale : median(singles.map((b) => b.W));

  const candidates = [];
  let unresolved = 0;
  for (const b of boxes) {
    const single = b.aspect >= o.minAspect && b.aspect <= o.maxAspect && b.fill >= o.minFill && b.area <= maxArea;
    if (single) { candidates.push({ ...b, split: false }); continue; }
    // bloco com várias peças enfileiradas? (cada peça tem proporção 2:1)
    if (b.fill >= o.minFill) {
      const ratio = b.L / (2 * b.W);
      const n = Math.round(ratio);
      const refOk = refW <= 0 || (b.W >= 0.7 * refW && b.W <= 1.4 * refW);
      if (n >= 2 && Math.abs(ratio - n) <= 0.2 && refOk) {
        const cos = Math.cos(b.angle);
        const sin = Math.sin(b.angle);
        const len = b.L / n;
        for (let k = 0; k < n; k += 1) {
          const u = -b.L / 2 + len * (k + 0.5);
          candidates.push({
            cx: b.cx + u * cos, cy: b.cy + u * sin, angle: b.angle, L: len, W: b.W,
            area: b.area / n, aspect: len / b.W, fill: b.fill, clipped: b.clipped, split: true,
          });
        }
        continue;
      }
    }
    if (b.area >= minArea * 2) unresolved += 1;
  }

  const tiles = candidates.map((b) => {
    const full = {
      cx: b.cx / scale, cy: b.cy / scale, angle: b.angle, L: b.L / scale, W: b.W / scale,
    };
    const reading = readTile(fullGray, fullW, fullH, full, o);
    const qf = 0.6 + 0.4 * quality.score;
    const confidence = reading.confidence * qf * (b.split ? 0.95 : 1) * (b.clipped ? 0.4 : 1);
    const dx = Math.cos(full.angle);
    const dy = Math.sin(full.angle);
    return {
      cx: full.cx, cy: full.cy, nx: full.cx / fullW, ny: full.cy / fullH,
      angle: full.angle, L: full.L, W: full.W,
      dir: { x: dx, y: dy },
      endA: { x: full.cx - dx * full.L / 2, y: full.cy - dy * full.L / 2 },
      endB: { x: full.cx + dx * full.L / 2, y: full.cy + dy * full.L / 2 },
      fill: b.fill, clipped: b.clipped, split: b.split,
      halves: reading.halves, counts: reading.counts, confidence,
      dividerFound: reading.dividerFound,
    };
  });
  tiles.sort((a, b) => a.cx - b.cx);
  return { tiles, quality, threshold, unresolved, width: fullW, height: fullH };
}

/* -------------------------------------------------------------------------
 * Calibração automática: escolhe polaridade (peça clara/escura) e limiar
 * ----------------------------------------------------------------------- */
export function autoCalibrate(frame, options = {}) {
  let best = null;
  for (const polarity of ['light', 'dark']) {
    for (const offset of [0, -18, 18]) {
      const res = analyzeFrame(frame, { ...options, tilePolarity: polarity, thresholdOffset: offset });
      const good = res.tiles.filter((t) => t.confidence >= 0.55);
      const score = good.reduce((a, t) => a + t.confidence, 0) - 0.3 * (res.tiles.length - good.length);
      if (!best || score > best.score) best = { polarity, offset, res, good, score };
    }
  }
  if (!best || best.good.length === 0) {
    return { ok: false, message: 'Nenhuma peça foi reconhecida. Aproxime a câmera, melhore a luz e deixe as peças visíveis.' };
  }
  return {
    ok: true,
    tilePolarity: best.polarity,
    thresholdOffset: best.offset,
    tileWidth: median(best.good.map((t) => t.W)),
    tileCount: best.good.length,
    quality: best.res.quality,
  };
}
