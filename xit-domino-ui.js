/* ==========================================================================
 * XIT DOMINÓ — xit-domino-ui.js
 * Camada de visualização: monta elementos, desenha dominós em SVG, modais,
 * alertas e a marcação sobre o vídeo. Não contém regras de jogo nem estado:
 * o orquestrador (xit-domino.js) decide o que mostrar.
 * ========================================================================== */

import { createTileSet, parseTile, fmtTile } from './xit-domino-engine.js';
import { formatDuration } from './xit-domino-stats.js';
import { alertLabel } from './xit-domino-cheat-detector.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const $ = (id) => document.getElementById(id);
export { $ };

/* -------------------------------------------------------------------------
 * Construção de elementos
 * ----------------------------------------------------------------------- */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

function svg(tag, attrs = {}) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

/* -------------------------------------------------------------------------
 * Dominó em SVG
 * ----------------------------------------------------------------------- */
const LO = 0.27; const MID = 0.5; const HI = 0.73;
function pipPositions(n) {
  switch (n) {
    case 0: return [];
    case 1: return [[MID, MID]];
    case 2: return [[LO, LO], [HI, HI]];
    case 3: return [[LO, LO], [MID, MID], [HI, HI]];
    case 4: return [[LO, LO], [HI, LO], [LO, HI], [HI, HI]];
    case 5: return [[LO, LO], [HI, LO], [LO, HI], [HI, HI], [MID, MID]];
    case 6: return [[LO, LO], [LO, MID], [LO, HI], [HI, LO], [HI, MID], [HI, HI]];
    case 7: return [[LO, LO], [LO, MID], [LO, HI], [HI, LO], [HI, MID], [HI, HI], [MID, MID]];
    case 8: return [[LO, LO], [LO, MID], [LO, HI], [HI, LO], [HI, MID], [HI, HI], [MID, LO], [MID, HI]];
    case 9: return [[LO, LO], [LO, MID], [LO, HI], [HI, LO], [HI, MID], [HI, HI], [MID, LO], [MID, HI], [MID, MID]];
    default: {
      const pts = [];
      for (let i = 0; i < n; i += 1) pts.push([0.2 + 0.6 * ((i % 3) / 2), 0.15 + 0.7 * (Math.floor(i / 3) / Math.max(1, Math.ceil(n / 3) - 1))]);
      return pts;
    }
  }
}

/**
 * Desenha uma peça. a = lado esquerdo (ou superior), b = lado direito (ou inferior).
 * opts: { vertical, size (altura em px), glow, dim, label }
 */
export function dominoSVG(a, b, opts = {}) {
  const { vertical = false, size = 30, glow = false, dim = false } = opts;
  const long = size * 2;
  const w = vertical ? size : long;
  const h = vertical ? long : size;
  const root = svg('svg', { viewBox: `0 0 ${w} ${h}`, width: w, height: h, role: 'img', 'aria-label': `Peça ${a} ${b}` });
  if (dim) root.setAttribute('opacity', '0.45');
  if (glow) root.style.filter = 'drop-shadow(0 0 6px rgba(57,255,136,0.7))';
  root.append(svg('rect', { class: 'body', x: 1, y: 1, width: w - 2, height: h - 2, rx: size * 0.2, fill: '#0e1512', stroke: '#39ff88', 'stroke-width': 1.6 }));
  if (vertical) root.append(svg('line', { x1: size * 0.12, y1: h / 2, x2: w - size * 0.12, y2: h / 2, stroke: '#39ff88', 'stroke-width': 1.2, opacity: 0.8 }));
  else root.append(svg('line', { x1: w / 2, y1: size * 0.12, x2: w / 2, y2: h - size * 0.12, stroke: '#39ff88', 'stroke-width': 1.2, opacity: 0.8 }));
  const r = Math.max(1.6, size * (a > 6 || b > 6 ? 0.075 : 0.09));
  [[a, 0], [b, 1]].forEach(([n, half]) => {
    for (const [px, py] of pipPositions(n)) {
      let cx; let cy;
      if (vertical) { cx = px * size; cy = half * size + py * size; } else { cx = half * size + px * size; cy = py * size; }
      root.append(svg('circle', { cx, cy, r, fill: '#e8f0ec' }));
    }
  });
  return root;
}

export function tileSVGFromId(id, opts) {
  const t = parseTile(id);
  return dominoSVG(t.a, t.b, opts);
}

/* -------------------------------------------------------------------------
 * Toast, modal, seletor de peça
 * ----------------------------------------------------------------------- */
let toastTimer = null;
export function toast(message, isError = false, ms = 3200) {
  const node = $('toast');
  node.textContent = message;
  node.classList.toggle('error', isError);
  node.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.add('hidden'), ms);
}

export function showModal({ title, body, actions = [], onClose } = {}) {
  const root = $('modal-root');
  const backdrop = el('div', { class: 'modal-backdrop', role: 'dialog', 'aria-modal': 'true' });
  const modal = el('div', { class: 'modal' });
  const close = () => {
    if (backdrop.parentNode) backdrop.remove();
    if (onClose) onClose();
  };
  if (title) modal.append(el('h2', { text: title }));
  if (body) modal.append(body.nodeType ? body : el('p', { class: 'note', text: body }));
  if (actions.length) {
    const row = el('div', { class: 'row wrap' });
    for (const a of actions) {
      row.append(el('button', {
        class: `btn ${a.kind === 'primary' ? 'btn-primary' : a.kind === 'danger' ? 'btn-danger' : 'btn-ghost'}`,
        type: 'button',
        text: a.label,
        onclick: () => { if (a.keepOpen !== true) close(); if (a.onClick) a.onClick(); },
      }));
    }
    modal.append(row);
  }
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  backdrop.append(modal);
  root.append(backdrop);
  return { close, modal };
}

/** Grade com as peças do conjunto para o usuário escolher uma. */
export function openTilePicker({ title = 'Escolha a peça', maxPip = 6, disabled = new Set(), highlight = [], onPick, extraActions = [] }) {
  const grid = el('div', { class: 'picker-grid' });
  let handle;
  for (const id of createTileSet(maxPip)) {
    const t = parseTile(id);
    const btn = el('button', {
      class: `tile-btn${highlight.includes(id) ? ' selected' : ''}`, type: 'button', 'aria-label': `Peça ${fmtTile(id)}`,
      disabled: disabled.has(id) || null,
      onclick: () => { handle.close(); onPick(id); },
    });
    btn.append(dominoSVG(t.a, t.b, { size: 22, vertical: true }));
    grid.append(btn);
  }
  handle = showModal({
    title, body: grid,
    actions: [...extraActions, { label: 'Cancelar', kind: 'ghost' }],
  });
  return handle;
}

export function openChoice({ title, text, choices }) {
  return showModal({
    title, body: text ? el('p', { class: 'note', text }) : null,
    actions: choices,
  });
}

/* -------------------------------------------------------------------------
 * Navegação e estatísticas
 * ----------------------------------------------------------------------- */
export function setScreen(name) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === `screen-${name}`));
  window.scrollTo(0, 0);
}

export function formatClock(ms) {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function renderStats(summary) {
  $('stat-wins').textContent = String(summary.wins);
  $('stat-played').textContent = String(summary.played);
  $('stat-rate').textContent = `${summary.winRate}%`;
  $('stat-time').textContent = summary.totalTimeText;
  $('stat-tracked').textContent = String(summary.tracked);
}

const RESULT_TEXT = { win: 'Vitória', loss: 'Derrota', draw: 'Empate', abandoned: 'Abandonada' };

export function renderStatsPanel(summary) {
  const d = $('stats-detail');
  clear(d);
  d.append(
    el('div', { text: `Vitórias: ${summary.wins}  •  Derrotas: ${summary.losses}  •  Empates: ${summary.draws}` }),
    el('div', { text: `Taxa de vitórias: ${summary.winRate}%` }),
    el('div', { text: `Tempo total de jogo: ${summary.totalTimeText}` }),
    el('div', { text: `Partidas acompanhadas: ${summary.tracked}` }),
  );
  const list = $('stats-history');
  clear(list);
  const recent = summary.history.slice(-10).reverse();
  if (!recent.length) list.append(el('li', { text: 'Nenhuma partida registrada ainda.' }));
  for (const h of recent) {
    const date = h.endedAt ? new Date(h.endedAt).toLocaleDateString('pt-BR') : '';
    list.append(el('li', {},
      el('span', {}, el('span', { class: `tag ${h.result}`, text: RESULT_TEXT[h.result] }), ` ${h.modality || ''}`),
      el('span', { text: `${formatDuration(h.durationMs)} • ${h.moves} jogadas • ${date}` })));
  }
  $('stats-note').textContent = summary.persistent
    ? 'Dados salvos neste aparelho.'
    : 'Atenção: o navegador não permite salvar dados; as estatísticas valem só enquanto esta página estiver aberta.';
}

/* -------------------------------------------------------------------------
 * Nomes de jogadores e histórico
 * ----------------------------------------------------------------------- */
export function playerName(p, config) {
  if (p === 0) return 'Você';
  if (config.teams && p === 2) return 'Parceiro';
  return `Jogador ${p + 1}`;
}

export function describeEvent(ev, config) {
  const who = ev.type === 'block' ? '' : playerName(ev.player, config);
  switch (ev.type) {
    case 'play':
      return ev.end === 'start'
        ? `${who} abriu com ${fmtTile(ev.tileId)}`
        : `${who} jogou ${fmtTile(ev.tileId)} na ponta ${ev.end === 'left' ? 'esquerda' : 'direita'}`;
    case 'pass': return `${who} passou a vez`;
    case 'draw': return `${who} comprou ${ev.tileId ? fmtTile(ev.tileId) : 'uma peça'}`;
    case 'block': return 'O jogo foi fechado';
    default: return 'Evento';
  }
}

export function renderHistory(container, state) {
  clear(container);
  const last = state.events.slice(-8);
  if (!last.length) { container.append(el('li', { text: 'Nenhuma jogada ainda.' })); return; }
  last.forEach((ev, i) => {
    const n = state.events.length - last.length + i + 1;
    container.append(el('li', {}, el('span', { text: `${n}. ${describeEvent(ev, state.config)}` })));
  });
}

/* -------------------------------------------------------------------------
 * Linhas de peças e painel
 * ----------------------------------------------------------------------- */
export function renderTileList(container, ids, { size = 22, vertical = true, empty = 'Nenhuma peça.' } = {}) {
  clear(container);
  if (!ids.length) { container.append(el('span', { class: 'note', text: empty })); return; }
  for (const id of ids) {
    const t = parseTile(id);
    container.append(dominoSVG(t.a, t.b, { size, vertical }));
  }
}

export function renderChain(container, board, { size = 18 } = {}) {
  clear(container);
  if (!board.length) { container.append(el('span', { class: 'note', text: 'Mesa vazia.' })); return; }
  for (const t of board) container.append(dominoSVG(t.left, t.right, { size }));
}

export function renderDashboard(container, d) {
  clear(container);
  const item = (value, label, wide) => el('div', { class: `dash-item${wide ? ' wide' : ''}` }, el('b', { text: String(value) }), el('span', { text: label }));
  container.append(
    item(d.elapsed, 'Tempo decorrido'),
    item(d.players, 'Jogadores'),
    item(d.tableCount, 'Peças na mesa'),
    item(d.handCount, 'Peças na minha mão'),
    item(d.statusText, 'Estado da partida', true),
  );
  const ends = el('div', { class: 'dash-item wide' }, el('span', { text: 'Pontas abertas da mesa' }));
  if (d.ends) {
    ends.append(el('div', { class: 'ends' },
      el('span', { class: 'end-badge', text: d.ends.left }), el('span', { class: 'note', text: '◄ mesa ►' }), el('span', { class: 'end-badge', text: d.ends.right })));
  } else ends.append(el('b', { text: 'Mesa vazia' }));
  container.append(ends);
  const counts = el('div', { class: 'dash-item wide' }, el('span', { text: 'Peças dos outros jogadores' }),
    el('b', { text: d.othersText }));
  container.append(counts);
}

/* -------------------------------------------------------------------------
 * Melhor jogada
 * ----------------------------------------------------------------------- */
export function renderBestMove(container, rec, handlers = {}) {
  clear(container);
  if (!rec || rec.action === 'none') return;
  if (rec.action === 'wait') {
    container.append(el('h2', { text: 'AGUARDANDO' }), el('p', { class: 'waiting', text: rec.message }),
      el('p', { class: 'note', text: 'Assim que for a sua vez, a melhor jogada aparece aqui.' }));
    return;
  }
  if (rec.action === 'draw' || rec.action === 'pass') {
    container.append(el('h2', { text: rec.action === 'draw' ? 'COMPRE UMA PEÇA' : 'PASSE A VEZ' }), el('p', { text: rec.message }));
    container.append(el('div', { class: 'row' }, el('button', {
      class: 'btn btn-primary', type: 'button',
      text: rec.action === 'draw' ? 'Comprei uma peça' : 'Passei a vez',
      onclick: rec.action === 'draw' ? handlers.onDraw : handlers.onPass,
    })));
    return;
  }
  const { best, instructions, alternatives } = rec;
  const m = best.move;
  container.append(el('h2', { text: instructions.title }));
  const t = parseTile(m.tileId);
  const placed = m.placed;
  container.append(el('div', { class: 'best-tile' },
    dominoSVG(placed.left, placed.right, { size: 40, glow: true }),
    el('div', {},
      el('div', { text: `Peça selecionada: ${placed.left > placed.right ? `${t.b} | ${t.a}` : fmtTile(m.tileId)}` }),
      el('div', { class: 'note', text: m.end === 'start' ? 'Abertura da mesa' : `Extremidade: ${m.end === 'left' ? 'esquerda' : 'direita'}` }))));
  container.append(el('div', { class: 'note', text: 'Instrução:' }));
  container.append(el('ol', { class: 'steps' }, instructions.steps.map((s) => el('li', { text: s }))));
  container.append(el('ul', { class: 'reasons' }, best.reasons.map((r) => el('li', { text: r }))));
  if (alternatives.length) {
    container.append(el('div', { class: 'alt' }, 'Alternativas:', alternatives.map((a) => el('span', { class: 'alt-item' },
      dominoSVG(a.move.placed.left, a.move.placed.right, { size: 20, dim: true }),
      ` ${a.move.end === 'start' ? '' : a.move.end === 'left' ? '◄' : '►'}`))));
  }
  container.append(el('div', { class: 'row' }, el('button', {
    class: 'btn btn-primary', type: 'button', text: 'Confirmar esta jogada', onclick: handlers.onConfirm,
  })));
  container.append(el('p', { class: 'disclaimer', text: rec.disclaimer }));
}

/* -------------------------------------------------------------------------
 * Alertas de irregularidade
 * ----------------------------------------------------------------------- */
export function renderAlerts(container, findings, handlers = {}) {
  clear(container);
  for (const f of findings) {
    const box = el('div', { class: `alert ${f.level === 'confirmed' ? 'confirmed' : 'suspect'}`, dataset: { id: f.id } });
    box.append(
      el('button', { class: 'close', type: 'button', 'aria-label': 'Ignorar e fechar', text: '✕', onclick: () => handlers.onDismiss(f.id) }),
      el('span', { class: 'alert-label', text: alertLabel(f) }),
      el('p', { text: f.message }),
      el('div', { class: 'note', text: `Momento: ${new Date(f.time).toLocaleTimeString('pt-BR')}` }),
    );
    if (f.snapshot) box.append(el('img', { src: f.snapshot, alt: 'Captura do momento (somente neste aparelho)' }));
    const row = el('div', { class: 'row wrap' });
    if (f.level !== 'confirmed') row.append(el('button', { class: 'btn btn-ghost small', type: 'button', text: 'É irregularidade', onclick: () => handlers.onReview(f.id, 'confirmed') }));
    row.append(el('button', { class: 'btn btn-ghost small', type: 'button', text: 'Alarme falso', onclick: () => handlers.onReview(f.id, 'false-alarm') }));
    if (f.snapshot) row.append(el('a', { class: 'btn btn-ghost small', href: f.snapshot, download: `xit-domino-${f.id}.jpg`, text: 'Salvar imagem' }));
    box.append(row);
    container.append(box);
  }
}

/* -------------------------------------------------------------------------
 * Marcação sobre o vídeo
 * ----------------------------------------------------------------------- */
const STATUS_COLOR = { stable: '#39ff88', confirmed: '#39ff88', uncertain: '#ffcc33', unread: '#ff3b4e', conflict: '#ff3b4e' };

function drawRotatedRect(ctx, cx, cy, angle, L, W) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.strokeRect(-L / 2, -W / 2, L, W);
  ctx.beginPath(); ctx.moveTo(0, -W / 2); ctx.lineTo(0, W / 2); ctx.stroke();
  ctx.restore();
}

export function drawOverlay(canvas, { snapshot, calibration, recommendation, calibrating, state }) {
  const rect = canvas.getBoundingClientRect();
  const cw = Math.max(1, Math.round(rect.width));
  const ch = Math.max(1, Math.round(rect.height));
  if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, cw, ch);

  if (calibration) {
    ctx.save();
    ctx.setLineDash([8, 6]);
    ctx.lineWidth = 2;
    const draw = (r, color, label, active) => {
      ctx.strokeStyle = color;
      ctx.globalAlpha = active ? 1 : 0.7;
      ctx.strokeRect(r.x * cw, r.y * ch, r.w * cw, r.h * ch);
      ctx.fillStyle = color;
      ctx.font = 'bold 12px sans-serif';
      ctx.fillText(label, r.x * cw + 6, r.y * ch + 16);
    };
    draw(calibration.handRegion, '#39ff88', 'MINHA MÃO', calibrating === 'hand');
    draw(calibration.tableRegion, '#9ad7ff', 'MESA', calibrating === 'table');
    ctx.restore();
  }

  if (snapshot && snapshot.frameSize) {
    const sx = cw / snapshot.frameSize.width;
    const sy = ch / snapshot.frameSize.height;
    ctx.lineWidth = 2;
    ctx.font = 'bold 12px sans-serif';
    const tracks = [...snapshot.hand, ...snapshot.table];
    for (const tr of tracks) {
      const g = tr.geom;
      if (!g) continue;
      const color = STATUS_COLOR[tr.status] || '#ffffff';
      ctx.strokeStyle = color; ctx.fillStyle = color;
      drawRotatedRect(ctx, g.cx * sx, g.cy * sy, g.angle, g.L * sx, g.W * sy);
      const label = tr.id ? tr.id.replace('-', '|') : `#${tr.trackId}?`;
      ctx.fillText(label, g.cx * sx - 12, g.cy * sy + 4);
    }

    if (recommendation && recommendation.action === 'play' && state) {
      const m = recommendation.best.move;
      let target = null;
      if (m.end === 'left' && snapshot.chain.length) target = snapshot.chain[0].endLeft;
      else if (m.end === 'right' && snapshot.chain.length) target = snapshot.chain[snapshot.chain.length - 1].endRight;
      if (target) {
        const x = target.x * sx; const y = target.y * sy;
        const pulse = 14 + 4 * Math.sin(Date.now() / 220);
        ctx.save();
        ctx.shadowColor = '#39ff88'; ctx.shadowBlur = 18;
        ctx.strokeStyle = '#39ff88'; ctx.fillStyle = '#39ff88'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(x, y, pulse, 0, Math.PI * 2); ctx.stroke();
        const dir = m.end === 'left' ? -1 : 1;
        ctx.beginPath(); ctx.moveTo(x + dir * (pulse + 26), y); ctx.lineTo(x + dir * (pulse + 4), y); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x + dir * (pulse + 4), y); ctx.lineTo(x + dir * (pulse + 14), y - 7); ctx.lineTo(x + dir * (pulse + 14), y + 7); ctx.closePath(); ctx.fill();
        ctx.font = 'bold 13px sans-serif';
        ctx.fillText(`${fmtTile(m.tileId)} (${m.touch})`, Math.min(cw - 70, Math.max(4, x - 28)), y - pulse - 8);
        ctx.restore();
      }
    }
  }
}
