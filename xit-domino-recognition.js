/* ==========================================================================
 * XIT DOMINÓ — xit-domino-recognition.js
 * Transforma detecções quadro a quadro em informação confiável do jogo.
 *
 *  - Rastreia cada peça entre quadros (casamento por distância).
 *  - Acumula "votos" ponderados pela confiança; só considera a peça ESTÁVEL
 *    quando a leitura se repete. Peças incertas NUNCA recebem número
 *    inventado: ficam pendentes e o usuário confirma/corrige.
 *  - Separa MINHA MÃO e MESA por regiões calibradas.
 *  - Ordena a cadeia da mesa (inclusive curvas e carroças atravessadas) e
 *    orienta cada peça (valor esquerdo/direito), validando os encaixes.
 *  - Compara a mesa observada com o estado do jogo e PROPÕE jogadas;
 *    quem aplica é o app (automático só quando tudo está estável).
 * Não enxerga peças escondidas nem de outros jogadores: só o que está na imagem.
 * ========================================================================== */

import { analyzeFrame } from './xit-domino-vision.js';
import { tileId, parseTile, SEAT_ME } from './xit-domino-engine.js';

export const DEFAULT_RECOGNITION = Object.freeze({
  minReadConfidence: 0.45,
  stableFrames: 3,
  stableWeight: 2.0,
  stableShare: 0.7,
  maxMissingFrames: 12,
  matchDistFactor: 0.7,
  decay: 0.9,
});

export function defaultCalibration() {
  return {
    handRegion: { x: 0, y: 0.62, w: 1, h: 0.38 },   // normalizado 0..1 sobre o vídeo
    tableRegion: { x: 0, y: 0, w: 1, h: 0.62 },
    tilePolarity: 'light',
    thresholdOffset: 0,
    tileWidth: 0,
    calibrated: false,
  };
}

const inRect = (r, nx, ny) => nx >= r.x && nx <= r.x + r.w && ny >= r.y && ny <= r.y + r.h;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function classifyZone(cal, nx, ny) {
  if (inRect(cal.handRegion, nx, ny)) return 'hand';
  if (inRect(cal.tableRegion, nx, ny)) return 'table';
  return 'outside';
}

/* -------------------------------------------------------------------------
 * Ordenação e orientação da cadeia da mesa
 * items: [{trackId, id|null, geom, halves:[vA,vB]|null, tileStatus}]
 * ----------------------------------------------------------------------- */
function median(list) {
  if (!list.length) return 0;
  const s = list.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export function orderChain(items) {
  const problems = [];
  const n = items.length;
  if (n === 0) return { chain: [], ordered: true, complete: true, problems };

  const W = median(items.map((it) => it.geom.W));
  const tol = 0.85 * W;
  const ends = items.map((it) => [it.geom.endA, it.geom.endB]);
  const isDouble = items.map((it) => !!it.id && parseTile(it.id).a === parseTile(it.id).b);

  // arestas entre pontas de peças vizinhas
  const edges = [];
  const degree = new Array(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      let best = null;
      for (let ei = 0; ei < 2; ei += 1) {
        for (let ej = 0; ej < 2; ej += 1) {
          const d = dist(ends[i][ei], ends[j][ej]);
          if (d < tol && (!best || d < best.d)) best = { i, ei, j, ej, d };
        }
      }
      if (best) { edges.push(best); degree[i] += 1; degree[j] += 1; }
    }
  }

  // carroças atravessadas: vizinhos tocam o meio dos lados, não as pontas
  const cross = new Array(n).fill(false);
  const pseudo = ends.map((e) => e.slice());
  for (let k = 0; k < n; k += 1) {
    if (!isDouble[k] || degree[k] > 0) continue;
    const g = items[k].geom;
    const nx = -g.dir.y;
    const ny = g.dir.x;
    const sideA = { x: g.cx - nx * g.W / 2, y: g.cy - ny * g.W / 2 };
    const sideB = { x: g.cx + nx * g.W / 2, y: g.cy + ny * g.W / 2 };
    const cand = [sideA, sideB];
    for (let m = 0; m < n; m += 1) {
      if (m === k) continue;
      for (let em = 0; em < 2; em += 1) {
        for (let s = 0; s < 2; s += 1) {
          const d = dist(ends[m][em], cand[s]);
          if (d < tol) {
            const i = Math.min(k, m);
            const j = Math.max(k, m);
            const ei = i === k ? s : em;
            const ej = j === k ? s : em;
            if (!edges.some((e) => e.i === i && e.j === j)) {
              edges.push({ i, ei, j, ej, d });
              degree[k] += 1; degree[m] += 1;
              cross[k] = true;
              pseudo[k] = cand;
            }
          }
        }
      }
    }
  }

  const fallback = (why) => {
    problems.push({ type: 'order-uncertain', message: why });
    const order = items.map((_, i) => i).sort((a, b) => items[a].geom.cx - items[b].geom.cx);
    const chain = order.map((i) => {
      const it = items[i];
      const hv = it.halves;
      const leftIsA = items[i].geom.endA.x <= items[i].geom.endB.x;
      return {
        trackId: it.trackId, id: it.id, geom: it.geom,
        left: hv ? (leftIsA ? hv[0] : hv[1]) : null,
        right: hv ? (leftIsA ? hv[1] : hv[0]) : null,
        endLeft: leftIsA ? it.geom.endA : it.geom.endB,
        endRight: leftIsA ? it.geom.endB : it.geom.endA,
        status: it.tileStatus,
      };
    });
    return { chain, ordered: false, complete: chain.every((c) => c.id), problems };
  };

  if (edges.length !== n - 1 || degree.some((d) => d > 2)) {
    return fallback(n > 1 ? 'Não foi possível determinar a ordem das peças na mesa com segurança. Confira ou corrija manualmente.' : '');
  }

  // percorre o caminho
  const adj = Array.from({ length: n }, () => []);
  for (const e of edges) {
    adj[e.i].push({ to: e.j, myEnd: e.ei, theirEnd: e.ej });
    adj[e.j].push({ to: e.i, myEnd: e.ej, theirEnd: e.ei });
  }
  const terminals = n === 1 ? [0] : adj.map((a, i) => (a.length === 1 ? i : -1)).filter((i) => i >= 0);
  if (terminals.length === 0) return fallback('A cadeia forma um ciclo.');
  terminals.sort((a, b) => items[a].geom.cx - items[b].geom.cx);
  const path = [];
  const seen = new Set();
  let cur = terminals[0];
  let prev = -1;
  while (cur !== -1 && !seen.has(cur)) {
    seen.add(cur);
    const link = adj[cur].find((l) => l.to !== prev);
    path.push({ idx: cur, nextEnd: link ? link.myEnd : null, prevEnd: null });
    prev = cur;
    cur = link ? link.to : -1;
  }
  if (path.length !== n) return fallback('Peças desconectadas na mesa.');
  for (let p = 1; p < path.length; p += 1) {
    const link = adj[path[p].idx].find((l) => l.to === path[p - 1].idx);
    path[p].prevEnd = link.myEnd;
  }

  const chain = [];
  for (let p = 0; p < path.length; p += 1) {
    const { idx, nextEnd } = path[p];
    let { prevEnd } = path[p];
    const it = items[idx];
    let rightEndIdx = nextEnd;
    if (rightEndIdx === null) rightEndIdx = prevEnd === 0 ? 1 : 0;       // última peça
    let leftEndIdx = prevEnd;
    if (leftEndIdx === null) leftEndIdx = rightEndIdx === 0 ? 1 : 0;     // primeira peça
    if (n === 1) {
      const a = it.geom.endA;
      const b = it.geom.endB;
      leftEndIdx = a.x <= b.x ? 0 : 1;
      rightEndIdx = leftEndIdx === 0 ? 1 : 0;
    }

    let left = null;
    let right = null;
    if (it.id) {
      const t = parseTile(it.id);
      if (cross[idx] || t.a === t.b) {
        left = t.a; right = t.b;
      } else if (it.halves) {
        left = leftEndIdx === 0 ? it.halves[0] : it.halves[1];
        right = rightEndIdx === 0 ? it.halves[0] : it.halves[1];
      } else {
        // orientação desconhecida (correção manual): escolhe a que encaixa no vizinho
        const prevRight = chain.length ? chain[chain.length - 1].right : null;
        if (prevRight === t.b) { left = t.b; right = t.a; } else { left = t.a; right = t.b; }
      }
    }
    chain.push({
      trackId: it.trackId, id: it.id, geom: it.geom, left, right,
      endLeft: pseudo[idx][leftEndIdx], endRight: pseudo[idx][rightEndIdx], status: it.tileStatus,
    });
  }

  for (let i = 0; i < chain.length - 1; i += 1) {
    const a = chain[i];
    const b = chain[i + 1];
    if (a.right !== null && b.left !== null && a.right !== b.left) {
      problems.push({
        type: 'mismatch', at: i,
        message: `As peças ${a.id} e ${b.id} não encaixam (${a.right} x ${b.left}). Alguma leitura pode estar errada.`,
      });
    }
  }
  return { chain, ordered: true, complete: chain.every((c) => c.id), problems };
}

/* -------------------------------------------------------------------------
 * Reconhecedor com memória entre quadros
 * ----------------------------------------------------------------------- */
export function createRecognizer(gameConfig = {}, options = {}) {
  const opt = { ...DEFAULT_RECOGNITION, ...options };
  const maxPip = gameConfig.maxPip || 6;
  let cal = { ...defaultCalibration(), ...(options.calibration || {}) };
  let tracks = [];
  let nextId = 1;
  let last = null;

  function newTrack(zone) {
    return {
      trackId: nextId++, zone, votes: new Map(), reads: 0, missing: 0,
      geom: null, halves: null, override: null, lastConf: 0, frames: 0,
    };
  }

  function setGeom(tr, det) {
    const newGeom = {
      cx: det.cx, cy: det.cy, nx: det.nx, ny: det.ny, angle: det.angle, L: det.L, W: det.W,
      dir: det.dir, endA: det.endA, endB: det.endB,
    };
    if (tr.geom && tr.geom.dir.x * det.dir.x + tr.geom.dir.y * det.dir.y < 0 && tr.halves) {
      tr.halves = [tr.halves[1], tr.halves[0]]; // a peça "virou" 180° no referencial: mantém coerência
    }
    tr.geom = newGeom;
  }

  function process(frame) {
    const res = analyzeFrame(frame, {
      tilePolarity: cal.tilePolarity, thresholdOffset: cal.thresholdOffset, tileWidth: cal.tileWidth, maxPip,
    });
    const dets = res.tiles
      .map((d) => ({ ...d, zone: classifyZone(cal, d.nx, d.ny) }))
      .filter((d) => d.zone !== 'outside');

    // casamento por distância (guloso)
    const pairs = [];
    dets.forEach((d, di) => {
      tracks.forEach((tr, ti) => {
        const dd = Math.hypot(d.cx - tr.geom.cx, d.cy - tr.geom.cy);
        if (dd < opt.matchDistFactor * d.L) pairs.push({ di, ti, dd });
      });
    });
    pairs.sort((a, b) => a.dd - b.dd);
    const usedD = new Set();
    const usedT = new Set();
    for (const p of pairs) {
      if (usedD.has(p.di) || usedT.has(p.ti)) continue;
      usedD.add(p.di); usedT.add(p.ti);
      const tr = tracks[p.ti];
      const d = dets[p.di];
      tr.missing = 0;
      tr.frames += 1;
      tr.zone = d.zone;
      setGeom(tr, d);
      applyReading(tr, d);
    }
    dets.forEach((d, di) => {
      if (usedD.has(di)) return;
      const tr = newTrack(d.zone);
      tr.frames = 1;
      setGeom(tr, d);
      applyReading(tr, d);
      tracks.push(tr);
    });
    for (const tr of tracks) {
      if (!tr._touched) tr.missing += 1;
      tr._touched = false;
    }
    tracks = tracks.filter((tr) => tr.missing <= opt.maxMissingFrames);

    last = snapshot(res);
    return last;
  }

  function applyReading(tr, d) {
    tr._touched = true;
    tr.lastConf = d.confidence;
    if (d.halves && d.confidence >= opt.minReadConfidence) {
      for (const [k, v] of tr.votes) tr.votes.set(k, v * opt.decay);
      const id = tileId(d.halves[0], d.halves[1]);
      tr.votes.set(id, (tr.votes.get(id) || 0) + d.confidence);
      tr.reads += 1;
      tr.halves = d.halves.slice();
    }
  }

  function describe(tr) {
    const total = Array.from(tr.votes.values()).reduce((a, b) => a + b, 0);
    const ranked = Array.from(tr.votes.entries()).sort((a, b) => b[1] - a[1]);
    const candidates = ranked.slice(0, 3).map(([id, w]) => ({ tileId: id, weight: w }));
    let status = 'unread';
    let id = null;
    if (tr.override) {
      status = 'confirmed'; id = tr.override;
    } else if (ranked.length) {
      const [bestId, bestW] = ranked[0];
      const share = total > 0 ? bestW / total : 0;
      if (tr.reads >= opt.stableFrames && bestW >= opt.stableWeight && share >= opt.stableShare) {
        status = 'stable'; id = bestId;
      } else status = 'uncertain';
    }
    // orientação conhecida somente se a última leitura corresponde ao id adotado
    const halves = tr.halves && id && tileId(tr.halves[0], tr.halves[1]) === id ? tr.halves : null;
    return {
      trackId: tr.trackId, zone: tr.zone, status, id, candidates, halves,
      geom: tr.geom, lastConfidence: tr.lastConf, reads: tr.reads,
    };
  }

  function snapshot(res) {
    const described = tracks.filter((t) => t.missing <= 2 || t.override).map(describe);
    // conflitos: a mesma peça em duas posições
    const byId = new Map();
    for (const d of described) {
      if (!d.id) continue;
      if (!byId.has(d.id)) byId.set(d.id, []);
      byId.get(d.id).push(d);
    }
    for (const list of byId.values()) {
      if (list.length > 1) list.forEach((d) => { if (d.status !== 'confirmed') d.status = 'conflict'; });
    }
    const hand = described.filter((d) => d.zone === 'hand');
    const table = described.filter((d) => d.zone === 'table');
    const items = table.map((d) => ({
      trackId: d.trackId, id: d.status === 'stable' || d.status === 'confirmed' ? d.id : null,
      geom: d.geom, halves: d.halves, tileStatus: d.status,
    }));
    const order = orderChain(items);
    const needsConfirmation = described.filter((d) => ['uncertain', 'unread', 'conflict'].includes(d.status));
    const okTracks = described.filter((d) => d.status === 'stable' || d.status === 'confirmed');
    return {
      quality: res.quality,
      unresolved: res.unresolved,
      hand,
      table,
      handIds: hand.filter((d) => d.status === 'stable' || d.status === 'confirmed').map((d) => d.id),
      chain: order.chain,
      chainOrdered: order.ordered,
      chainComplete: order.complete,
      chainProblems: order.problems,
      needsConfirmation,
      recognitionRate: described.length ? okTracks.length / described.length : 1,
      frameSize: { width: res.width, height: res.height },
    };
  }

  return {
    process,
    getLast() { return last; },
    getCalibration() { return { ...cal }; },
    setCalibration(next) { cal = { ...cal, ...next }; },
    reset() { tracks = []; last = null; },

    /** Usuário confirma/corrige a peça de um rastro. tileIdValue = "a-b" ou null para limpar. */
    confirm(trackId, tileIdValue) {
      const tr = tracks.find((t) => t.trackId === trackId);
      if (!tr) return false;
      if (tileIdValue === null) { tr.override = null; return true; }
      const t = parseTile(tileIdValue);
      if (!t || t.b > maxPip) return false;
      tr.override = tileIdValue;
      return true;
    },
  };
}

/* -------------------------------------------------------------------------
 * Mão inicial a partir da observação
 * ----------------------------------------------------------------------- */
export function suggestInitialHand(obs, handSize) {
  if (!obs) return { ok: false, message: 'Aponte a câmera para a sua mão.' };
  const pending = obs.hand.filter((d) => !['stable', 'confirmed'].includes(d.status));
  if (pending.length) {
    return { ok: false, message: `${pending.length} peça(s) da mão ainda não foram reconhecidas com certeza. Confirme-as ou melhore a imagem.` };
  }
  if (obs.handIds.length !== handSize) {
    return { ok: false, message: `Foram reconhecidas ${obs.handIds.length} peças na mão, mas a partida usa ${handSize}.` };
  }
  return { ok: true, ids: obs.handIds.slice().sort() };
}

/* -------------------------------------------------------------------------
 * Propostas de jogada comparando a mesa observada com o estado do jogo
 * ----------------------------------------------------------------------- */
const sameIds = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

export function proposeEvents(state, obs) {
  const result = { events: [], questions: [], autoApplicable: false };
  if (!obs || state.status !== 'playing') return result;

  if (obs.table.some((d) => ['uncertain', 'unread', 'conflict'].includes(d.status))) {
    const n = obs.table.filter((d) => ['uncertain', 'unread', 'conflict'].includes(d.status)).length;
    result.questions.push(`${n} peça(s) da mesa ainda não foram reconhecidas com certeza.`);
    return result;
  }
  if (!obs.chainOrdered && obs.chain.length > 1) {
    result.questions.push('Não foi possível determinar a ordem das peças na mesa.');
    return result;
  }

  const chainIds = obs.chain.map((c) => c.id);
  const recorded = state.board.map((t) => t.id);
  if (chainIds.length <= recorded.length) return result;

  const extra = chainIds.length - recorded.length;
  let offset = -1;
  for (let k = 0; k + recorded.length <= chainIds.length; k += 1) {
    if (sameIds(chainIds.slice(k, k + recorded.length), recorded)) { offset = k; break; }
  }
  if (recorded.length === 0) offset = 0;
  if (offset < 0) {
    result.questions.push('A mesa observada não bate com o histórico registrado. Confira as peças ou corrija manualmente.');
    return result;
  }

  const leftNew = chainIds.slice(0, offset).reverse();            // do mais próximo para o mais distante
  const rightNew = chainIds.slice(offset + recorded.length);
  const plan = [];
  if (recorded.length === 0) {
    if (extra > 1) {
      result.questions.push('Várias peças novas apareceram de uma vez. Registre as jogadas manualmente, na ordem em que aconteceram.');
      return result;
    }
    plan.push({ id: chainIds[0], end: 'start' });
  } else {
    leftNew.forEach((id) => plan.push({ id, end: 'left' }));
    rightNew.forEach((id) => plan.push({ id, end: 'right' }));
  }

  const players = state.config.players;
  let turn = state.turn;
  let needsPlayerConfirm = extra > 1 || (leftNew.length > 0 && rightNew.length > 0);
  for (const step of plan) {
    let player = turn;
    if (state.myHand.includes(step.id)) player = SEAT_ME;
    else if (turn === SEAT_ME) needsPlayerConfirm = true;
    result.events.push({ type: 'play', player, tileId: step.id, end: step.end });
    turn = (player + 1) % players;
  }
  if (extra > 1) result.questions.push('Mais de uma peça nova foi vista; confirme quem jogou cada uma.');
  if (needsPlayerConfirm) result.questions.push('Confirme quem fez esta jogada.');
  result.autoApplicable = result.events.length === 1 && !needsPlayerConfirm;
  return result;
}
