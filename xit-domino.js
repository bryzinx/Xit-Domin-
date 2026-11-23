/* ==========================================================================
 * XIT DOMINÓ — xit-domino.js
 * Orquestrador: liga a interface aos módulos de motor, estratégia, câmera,
 * visão, reconhecimento, estatísticas e detector de irregularidades.
 * Fluxo: início -> configuração (7 perguntas) -> mão/câmera -> partida -> resultado.
 * ========================================================================== */

import {
  RULE_PRESETS, normalizeConfig, createGame, applyEvent, undoLastEvent, serializeGame,
  deserializeGame, getEnds, unseenTiles, boneyardSize, parseTile, fmtTile, teamOf, pipCount,
  checkConsistency, totalTiles, SEAT_ME,
} from './xit-domino-engine.js';
import { recommend } from './xit-domino-strategy.js';
import { createStatsStore, resultFromGame, formatDuration } from './xit-domino-stats.js';
import { createCheatDetector, alertLabel } from './xit-domino-cheat-detector.js';
import { createCamera, cameraSupport, importImageFile } from './xit-domino-camera.js';
import { createRecognizer, defaultCalibration, suggestInitialHand, proposeEvents } from './xit-domino-recognition.js';
import { autoCalibrate } from './xit-domino-vision.js';
import * as ui from './xit-domino-ui.js';

const { $, el } = ui;

const GAME_KEY = 'xit-domino:game:v1';
const CAL_KEY = 'xit-domino:calibration:v1';
const SETTINGS_KEY = 'xit-domino:settings:v1';
const FRAME_WIDTH = 800;
const AUTO_APPLY_FRAMES = 6;
const SHOW_PROPOSAL_FRAMES = 3;

/* -------------------------------------------------------------------------
 * Armazenamento local seguro
 * ----------------------------------------------------------------------- */
const store = {
  get(key) { try { return globalThis.localStorage.getItem(key); } catch (e) { return null; } },
  set(key, value) { try { globalThis.localStorage.setItem(key, value); return true; } catch (e) { return false; } },
  remove(key) { try { globalThis.localStorage.removeItem(key); } catch (e) { /* ignora */ } },
  json(key) { try { const t = this.get(key); return t ? JSON.parse(t) : null; } catch (e) { return null; } },
};

/* -------------------------------------------------------------------------
 * Estado do aplicativo
 * ----------------------------------------------------------------------- */
const app = {
  phase: 'home',               // home | setup | deal | playing | result
  stats: createStatsStore(),
  settings: { autoApply: true, allowSnapshots: false, ...(store.json(SETTINGS_KEY) || {}) },
  wizard: { step: 0, answers: null },
  config: null,
  dealHand: [],
  starter: 0,
  game: null,
  startedAt: 0,
  accumulated: 0,
  camera: null,
  recognizer: null,
  detector: null,
  calibration: { ...defaultCalibration(), ...(store.json(CAL_KEY) || {}) },
  calibrating: null,
  dragStart: null,
  snapshot: null,
  recommendation: null,
  proposalKey: null,
  proposalCount: 0,
  ignoredProposals: new Set(),
  stillMode: false,
  stillFrame: null,
  lastResult: null,
};

/* -------------------------------------------------------------------------
 * Navegação e estatísticas
 * ----------------------------------------------------------------------- */
function goHome() {
  stopCamera();
  app.phase = 'home';
  app.game = null;
  refreshHome();
  ui.setScreen('home');
}

function refreshHome() {
  const summary = app.stats.getSummary();
  ui.renderStats(summary);
  ui.renderStatsPanel(summary);
  $('btn-resume').classList.toggle('hidden', !loadSavedGame());
}

/* -------------------------------------------------------------------------
 * Assistente de configuração (7 perguntas)
 * ----------------------------------------------------------------------- */
function freshAnswers(base) {
  const preset = base || RULE_PRESETS.brasileiro;
  return { ...preset, preset: preset.id || 'custom', endRule: 'lowest-pips' };
}

function startWizard(answers) {
  app.wizard = { step: 0, answers: freshAnswers(answers) };
  app.phase = 'setup';
  ui.setScreen('setup');
  renderWizard();
}

function optionButton(label, hint, selected, onClick) {
  return el('button', { class: `option${selected ? ' selected' : ''}`, type: 'button', onclick: onClick },
    label, hint ? el('small', { text: hint }) : null);
}

function stepper(value, min, max, onChange) {
  const val = el('div', { class: 'value', text: String(value) });
  const dec = el('button', { class: 'btn btn-ghost', type: 'button', text: '−', 'aria-label': 'Diminuir', onclick: () => onChange(Math.max(min, value - 1)) });
  const inc = el('button', { class: 'btn btn-ghost', type: 'button', text: '+', 'aria-label': 'Aumentar', onclick: () => onChange(Math.min(max, value + 1)) });
  return el('div', { class: 'stepper' }, dec, val, inc);
}

const SETS = { 6: 'Duplo-6 (28 peças)', 9: 'Duplo-9 (55 peças)', 12: 'Duplo-12 (91 peças)' };
const DEFAULT_HAND = (players, maxPip) => (maxPip === 6 ? (players === 4 ? 6 : 7) : maxPip === 9 ? 10 : 12);

const WIZARD_STEPS = [
  {
    title: 'Qual modalidade de dominó será utilizada?',
    help: 'Escolha uma regra pronta ou configure tudo manualmente nas próximas perguntas.',
    render(a, set, box) {
      for (const p of Object.values(RULE_PRESETS)) {
        box.append(optionButton(p.name, `${p.players} jogadores • ${p.handSize} peças cada • ${p.drawRule === 'none' ? 'sem compra' : 'com compra'}`,
          a.preset === p.id, () => { set({ ...p, preset: p.id }); }));
      }
      box.append(optionButton('Configurar manualmente', 'Você define cada regra nas próximas telas', a.preset === 'custom', () => set({ preset: 'custom' })));
    },
  },
  {
    title: 'Quantos jogadores estão participando?',
    help: 'Conte você também.',
    render(a, set, box) {
      for (const n of [2, 3, 4]) {
        box.append(optionButton(`${n} jogadores`, '', a.players === n, () => {
          set({ players: n, teams: n === 4 ? a.teams : false, handSize: DEFAULT_HAND(n, a.maxPip), preset: 'custom' });
        }));
      }
    },
  },
  {
    title: 'Quantas peças cada jogador recebe?',
    help: '',
    render(a, set, box, helpEl) {
      const max = Math.max(1, Math.floor(totalTiles(a.maxPip) / a.players));
      box.append(stepper(a.handSize, 1, max, (v) => set({ handSize: v, preset: 'custom' })));
      const left = totalTiles(a.maxPip) - a.players * a.handSize;
      helpEl.textContent = `Sobram ${left} peça(s) ${a.drawRule === 'none' ? '(dormem, não são compradas)' : 'para o monte de compra'}.`;
    },
  },
  {
    title: 'Qual é o conjunto de peças utilizado?',
    help: 'Número máximo de pontos em cada metade da peça.',
    render(a, set, box) {
      for (const [k, label] of Object.entries(SETS)) {
        box.append(optionButton(label, '', a.maxPip === Number(k), () => {
          set({ maxPip: Number(k), handSize: DEFAULT_HAND(a.players, Number(k)), preset: 'custom' });
        }));
      }
    },
  },
  {
    title: 'Existem regras especiais?',
    help: 'Estas regras influenciam as jogadas e a estratégia.',
    render(a, set, box) {
      if (a.players === 4) {
        box.append(optionButton('Jogo em duplas', 'Você e o parceiro (sentado à sua frente) jogam juntos', a.teams, () => set({ teams: !a.teams, preset: 'custom' })));
      }
      box.append(optionButton('Abertura com a maior carroça', 'Quem tem a maior carroça abre o jogo', a.firstMove === 'highest-double', () => set({ firstMove: 'highest-double', preset: 'custom' })));
      box.append(optionButton('Abertura livre', 'Quem começa joga qualquer peça', a.firstMove === 'any', () => set({ firstMove: 'any', preset: 'custom' })));
    },
  },
  {
    title: 'Como funciona a compra de peças?',
    help: '',
    render(a, set, box, helpEl) {
      const opts = [
        ['none', 'Sem compra', 'Sem jogada, o jogador passa a vez'],
        ['single', 'Compra uma peça', 'Compra uma vez; se não servir, passa'],
        ['until-playable', 'Compra até poder jogar', 'Compra do monte até achar uma peça que encaixe'],
      ];
      for (const [v, label, hint] of opts) box.append(optionButton(label, hint, a.drawRule === v, () => set({ drawRule: v, preset: 'custom' })));
      if (a.drawRule !== 'none') {
        const pool = Math.max(0, totalTiles(a.maxPip) - a.players * a.handSize);
        helpEl.textContent = `Peças que ficam no monte e não podem ser compradas (reserva): ${a.boneyardReserve} de ${pool}.`;
        box.append(stepper(a.boneyardReserve, 0, pool, (v) => set({ boneyardReserve: v, preset: 'custom' })));
      } else helpEl.textContent = '';
    },
  },
  {
    title: 'Qual é a regra de encerramento da partida?',
    help: 'A partida sempre termina quando alguém bate (fica sem peças) ou o jogo fecha.',
    render(a, set, box) {
      box.append(optionButton('Quem tiver menos pontos vence o jogo fechado', 'Mostro seus pontos na hora de decidir', a.endRule === 'lowest-pips', () => set({ endRule: 'lowest-pips' })));
      box.append(optionButton('Eu informo o resultado quando o jogo fechar', 'Para regras da sua mesa que contam diferente', a.endRule === 'manual', () => set({ endRule: 'manual' })));
    },
  },
];

function renderWizard() {
  const { step, answers } = app.wizard;
  const def = WIZARD_STEPS[step];
  $('setup-question').textContent = def.title;
  $('setup-help').textContent = def.help;
  $('setup-step-label').textContent = `${step + 1}/${WIZARD_STEPS.length}`;
  $('setup-progress-bar').style.width = `${((step + 1) / WIZARD_STEPS.length) * 100}%`;
  $('setup-next').textContent = step === WIZARD_STEPS.length - 1 ? 'CONCLUIR CONFIGURAÇÃO' : 'PRÓXIMO';
  $('setup-error').classList.add('hidden');
  const box = $('setup-options');
  ui.clear(box);
  const set = (patch) => { app.wizard.answers = { ...app.wizard.answers, ...patch }; renderWizard(); };
  def.render(answers, set, box, $('setup-help'));
}

function wizardNext() {
  const last = WIZARD_STEPS.length - 1;
  if (app.wizard.step < last) {
    app.wizard.step += 1;
    renderWizard();
    return;
  }
  const norm = normalizeConfig(app.wizard.answers);
  if (!norm.ok) {
    const err = $('setup-error');
    err.textContent = norm.errors.join(' ');
    err.classList.remove('hidden');
    return;
  }
  app.config = { ...norm.config, endRule: app.wizard.answers.endRule, name: norm.config.name };
  beginDeal();
}

function wizardBack() {
  if (app.wizard.step > 0) { app.wizard.step -= 1; renderWizard(); } else goHome();
}

/* -------------------------------------------------------------------------
 * Distribuição: minha mão e quem começa
 * ----------------------------------------------------------------------- */
function beginDeal() {
  app.phase = 'deal';
  app.dealHand = [];
  app.starter = 0;
  app.game = null;
  app.snapshot = null;
  app.recognizer = createRecognizer(app.config, { calibration: app.calibration });
  ui.setScreen('game');
  setGameLayout('deal');
  renderDeal();
  resetVideoUi();
}

function setGameLayout(phase) {
  $('deal-panel').classList.toggle('hidden', phase !== 'deal');
  $('play-panel').classList.toggle('hidden', phase !== 'playing');
  $('game-phase').textContent = phase === 'deal' ? 'MINHA MÃO' : 'EM JOGO';
}

function renderDeal() {
  const cfg = app.config;
  $('deal-help').textContent = `Aponte a câmera para suas ${cfg.handSize} peças dentro da área "MINHA MÃO" e toque em "Usar peças reconhecidas", ou adicione as peças manualmente. (${app.dealHand.length}/${cfg.handSize})`;
  const row = $('deal-hand');
  ui.clear(row);
  if (!app.dealHand.length) row.append(el('span', { class: 'note', text: 'Nenhuma peça escolhida ainda.' }));
  for (const id of app.dealHand) {
    const t = parseTile(id);
    row.append(el('button', {
      class: 'tile-btn', type: 'button', title: 'Toque para remover', 'aria-label': `Remover peça ${fmtTile(id)}`,
      onclick: () => { app.dealHand = app.dealHand.filter((x) => x !== id); renderDeal(); },
    }, ui.dominoSVG(t.a, t.b, { size: 24, vertical: true })));
  }
  const starters = $('deal-starter');
  ui.clear(starters);
  for (let p = 0; p < cfg.players; p += 1) {
    starters.append(optionButton(ui.playerName(p, cfg), '', app.starter === p, () => { app.starter = p; renderDeal(); }));
  }
  $('deal-error').classList.add('hidden');
}

function dealAddManual() {
  if (app.dealHand.length >= app.config.handSize) { ui.toast(`A mão já tem ${app.config.handSize} peças.`, true); return; }
  ui.openTilePicker({
    title: 'Adicionar peça à sua mão', maxPip: app.config.maxPip, disabled: new Set(app.dealHand),
    onPick: (id) => { app.dealHand.push(id); app.dealHand.sort(); renderDeal(); },
  });
}

function dealFromCamera() {
  const sug = suggestInitialHand(app.snapshot, app.config.handSize);
  if (!sug.ok) { ui.toast(sug.message, true, 4500); return; }
  app.dealHand = sug.ids;
  renderDeal();
  ui.toast('Mão reconhecida. Confira antes de iniciar.');
}

function dealStart() {
  const r = createGame(app.config, { myHand: app.dealHand, starter: app.starter });
  if (!r.ok) {
    const err = $('deal-error');
    err.textContent = r.error.message;
    err.classList.remove('hidden');
    return;
  }
  app.game = r.state;
  app.detector = createCheatDetector();
  app.detector.setSnapshotAllowed(app.settings.allowSnapshots);
  app.startedAt = Date.now();
  app.accumulated = 0;
  app.proposalKey = null; app.proposalCount = 0; app.ignoredProposals = new Set();
  app.recognizer.reset();
  app.stats.recordTracked();
  app.phase = 'playing';
  setGameLayout('playing');
  saveGame();
  refreshAll();
  ui.toast('Partida iniciada!');
}

/* -------------------------------------------------------------------------
 * Persistência da partida em andamento
 * ----------------------------------------------------------------------- */
function elapsedMs() {
  return app.phase === 'playing' ? app.accumulated + (Date.now() - app.startedAt) : app.accumulated;
}

function saveGame() {
  if (!app.game) return;
  store.set(GAME_KEY, JSON.stringify({ game: serializeGame(app.game), accumulated: elapsedMs(), endRule: app.config && app.config.endRule }));
}

function loadSavedGame() {
  const data = store.json(GAME_KEY);
  if (!data || typeof data.game !== 'string') return null;
  const r = deserializeGame(data.game);
  if (!r.ok || r.state.status !== 'playing') return null;
  return { state: r.state, accumulated: Number(data.accumulated) || 0, endRule: data.endRule || 'lowest-pips' };
}

function resumeGame() {
  const saved = loadSavedGame();
  if (!saved) { ui.toast('Nenhuma partida salva.', true); refreshHome(); return; }
  app.config = { ...saved.state.config, endRule: saved.endRule };
  app.game = saved.state;
  app.detector = createCheatDetector();
  app.detector.setSnapshotAllowed(app.settings.allowSnapshots);
  app.recognizer = createRecognizer(app.config, { calibration: app.calibration });
  app.accumulated = saved.accumulated;
  app.startedAt = Date.now();
  app.phase = 'playing';
  app.proposalKey = null; app.proposalCount = 0; app.ignoredProposals = new Set();
  ui.setScreen('game');
  setGameLayout('playing');
  resetVideoUi();
  refreshAll();
}

/* -------------------------------------------------------------------------
 * Painel da partida
 * ----------------------------------------------------------------------- */
function statusText(s) {
  if (s.status !== 'playing') return 'Partida encerrada';
  if (!s.board.length) return `Mesa vazia — ${ui.playerName(s.turn, s.config)} abre o jogo`;
  return s.turn === SEAT_ME ? 'É a sua vez' : `Vez de ${ui.playerName(s.turn, s.config)}`;
}

function refreshAll() {
  const s = app.game;
  if (!s) return;
  app.recommendation = recommend(s);
  ui.renderBestMove($('best-move'), app.recommendation, {
    onConfirm: () => confirmRecommendedMove(),
    onDraw: () => manualDraw(SEAT_ME),
    onPass: () => commitEvent({ type: 'pass', player: SEAT_ME }),
  });
  const ends = getEnds(s);
  const others = [];
  for (let p = 1; p < s.config.players; p += 1) others.push(`${ui.playerName(p, s.config)}: ${s.handCounts[p]}`);
  others.push(`monte/dormem: ${boneyardSize(s)}`);
  ui.renderDashboard($('dashboard'), {
    elapsed: ui.formatClock(elapsedMs()), players: s.config.players,
    tableCount: s.board.length, handCount: s.myHand.length,
    statusText: statusText(s), ends, othersText: others.join(' • '),
  });
  ui.renderTileList($('my-tiles'), s.myHand, { empty: 'Sem peças.' });
  ui.renderChain($('table-tiles'), s.board);
  ui.renderHistory($('history'), s);
  renderProblems();
  renderAlertsPanel();
  redrawOverlay();
}

function renderProblems() {
  const p = $('chain-problems');
  const msgs = [];
  if (app.snapshot && app.snapshot.chainProblems) app.snapshot.chainProblems.forEach((x) => x.message && msgs.push(x.message));
  if (app.game) checkConsistency(app.game).filter((i) => i.severity === 'error').forEach((i) => msgs.push(i.message));
  p.textContent = msgs.join(' ');
  p.classList.toggle('hidden', msgs.length === 0);
}

function renderAlertsPanel() {
  if (!app.detector) { ui.clear($('alerts')); return; }
  ui.renderAlerts($('alerts'), app.detector.open(), {
    onDismiss: (id) => { app.detector.dismiss(id); renderAlertsPanel(); },
    onReview: (id, verdict) => { app.detector.review(id, verdict); renderAlertsPanel(); },
  });
}

function handleNewFindings(findings) {
  if (!findings || !findings.length) return;
  for (const f of findings) {
    if (app.settings.allowSnapshots && app.camera && app.camera.isActive() && !app.stillMode) {
      const url = app.camera.snapshotDataUrl(0.8, { region: f.region, label: alertLabel(f) });
      if (url) app.detector.attachSnapshot(f.id, url);
    }
  }
  renderAlertsPanel();
  ui.toast(findings[0].level === 'confirmed' ? 'TRAPAÇA DETECTADA' : 'Irregularidade suspeita: revise o alerta.', true, 4200);
}

/* -------------------------------------------------------------------------
 * Aplicar eventos ao jogo
 * ----------------------------------------------------------------------- */
function commitEvent(ev, info = {}) {
  if (!app.game || app.game.status !== 'playing') return false;
  const r = app.detector.checkEvent(app.game, ev, info);
  handleNewFindings(r.findings);
  if (!r.ok) { ui.toast(r.error.message, true, 4500); return false; }
  app.game = r.state;
  saveGame();
  if (app.game.status !== 'playing') { finishGame(); return true; }
  refreshAll();
  return true;
}

function confirmRecommendedMove() {
  const rec = app.recommendation;
  if (!rec || rec.action !== 'play') return;
  const m = rec.best.move;
  commitEvent({ type: 'play', player: SEAT_ME, tileId: m.tileId, end: m.end });
}

function choosePlayer(title, preferred) {
  return new Promise((resolve) => {
    const cfg = app.game.config;
    let done = false;
    const choices = [];
    for (let p = 0; p < cfg.players; p += 1) {
      choices.push({ label: `${p === preferred ? '• ' : ''}${ui.playerName(p, cfg)}`, kind: p === preferred ? 'primary' : 'ghost', onClick: () => { done = true; resolve(p); } });
    }
    choices.push({ label: 'Cancelar', kind: 'ghost', onClick: () => { done = true; resolve(null); } });
    const h = ui.openChoice({ title, text: 'O destacado (•) é quem deveria jogar agora.', choices });
    h.modal.parentNode.addEventListener('click', (e) => { if (e.target === h.modal.parentNode && !done) resolve(null); });
  });
}

async function manualPlay() {
  const s = app.game;
  const player = await choosePlayer('Quem jogou?', s.turn);
  if (player === null) return;
  const used = new Set([...s.board.map((t) => t.id), ...(player === SEAT_ME ? [] : s.myHand)]);
  const unseen = new Set(unseenTiles(s));
  const disabled = new Set();
  for (let a = 0; a <= s.config.maxPip; a += 1) {
    for (let b = a; b <= s.config.maxPip; b += 1) {
      const id = `${a}-${b}`;
      if (used.has(id)) { disabled.add(id); continue; }
      if (player === SEAT_ME && !s.myHand.includes(id)) disabled.add(id);
      if (player !== SEAT_ME && !unseen.has(id)) disabled.add(id);
    }
  }
  ui.openTilePicker({
    title: `Qual peça ${ui.playerName(player, s.config)} jogou?`, maxPip: s.config.maxPip, disabled,
    onPick: (id) => {
      const ends = getEnds(s);
      if (!ends) { commitEvent({ type: 'play', player, tileId: id, end: 'start' }); return; }
      ui.openChoice({
        title: 'Em qual ponta?', text: `Esquerda mostra ${ends.left}; direita mostra ${ends.right}.`,
        choices: [
          { label: `Esquerda (${ends.left})`, kind: 'primary', onClick: () => commitEvent({ type: 'play', player, tileId: id, end: 'left' }) },
          { label: `Direita (${ends.right})`, kind: 'primary', onClick: () => commitEvent({ type: 'play', player, tileId: id, end: 'right' }) },
          { label: 'Cancelar', kind: 'ghost' },
        ],
      });
    },
  });
}

async function manualPass() {
  const player = await choosePlayer('Quem passou a vez?', app.game.turn);
  if (player !== null) commitEvent({ type: 'pass', player });
}

async function manualDraw(preset) {
  const s = app.game;
  const player = preset === SEAT_ME ? SEAT_ME : await choosePlayer('Quem comprou uma peça?', s.turn);
  if (player === null) return;
  if (player !== SEAT_ME) { commitEvent({ type: 'draw', player }); return; }
  const disabled = new Set([...s.myHand, ...s.board.map((t) => t.id)]);
  ui.openTilePicker({
    title: 'Qual peça você comprou?', maxPip: s.config.maxPip, disabled,
    onPick: (id) => commitEvent({ type: 'draw', player: SEAT_ME, tileId: id }),
  });
}

function manualUndo() {
  const r = undoLastEvent(app.game);
  if (!r.ok) { ui.toast(r.error ? r.error.message : 'Não foi possível desfazer.', true); return; }
  app.game = r.state;
  app.proposalKey = null; app.proposalCount = 0;
  saveGame();
  refreshAll();
  ui.toast('Última jogada desfeita.');
}

function manualBlock() {
  ui.openChoice({
    title: 'O jogo fechou?', text: 'Use quando ninguém mais consegue jogar.',
    choices: [{ label: 'Sim, o jogo fechou', kind: 'primary', onClick: () => commitEvent({ type: 'block' }) }, { label: 'Cancelar', kind: 'ghost' }],
  });
}

function manualEnd() {
  ui.openChoice({
    title: 'Encerrar a partida?', text: 'Ela será contada como abandonada e o tempo jogado entra nas estatísticas.',
    choices: [
      { label: 'Encerrar', kind: 'danger', onClick: abandonGame },
      { label: 'Continuar jogando', kind: 'ghost' },
    ],
  });
}

function abandonGame() {
  if (app.game) {
    app.stats.recordGame({ result: 'abandoned', durationMs: elapsedMs(), moves: app.game.events.length, modality: app.config.name });
  }
  store.remove(GAME_KEY);
  goHome();
}

/* -------------------------------------------------------------------------
 * Fim da partida
 * ----------------------------------------------------------------------- */
function finishGame() {
  const s = app.game;
  const duration = elapsedMs();
  app.accumulated = duration;
  app.phase = 'result';
  stopCamera();
  const complete = (result) => {
    const plays = s.events.filter((e) => e.type === 'play').length;
    app.stats.recordGame({ result, durationMs: duration, moves: plays, modality: app.config.name });
    store.remove(GAME_KEY);
    showResult(result, duration, plays);
  };
  const direct = resultFromGame(s);
  if (direct) { complete(direct); return; }
  // jogo fechado: os pontos dos outros não são visíveis, quem decide é o usuário
  const mine = pipCount(s.myHand);
  const hint = app.config.endRule === 'lowest-pips'
    ? `Você ficou com ${mine} ponto(s) na mão. Vence quem tiver menos pontos.`
    : `Você ficou com ${mine} ponto(s) na mão.`;
  ui.openChoice({
    title: 'Jogo fechado', text: `${hint} Qual foi o resultado?`,
    choices: [
      { label: 'Eu (ou minha dupla) venci', kind: 'primary', onClick: () => complete('win') },
      { label: 'Perdi', kind: 'ghost', onClick: () => complete('loss') },
      { label: 'Empate', kind: 'ghost', onClick: () => complete('draw') },
    ],
  });
}

const WIN_QUOTE = 'Você ganhou, não precisa mais jogar até a próxima rodada.';

function showResult(result, duration, plays) {
  const summary = app.stats.getSummary();
  const win = result === 'win';
  const resultText = { win: 'Vitória', loss: 'Derrota', draw: 'Empate' }[result];
  $('result-title').textContent = win ? 'VOCÊ GANHOU!' : result === 'draw' ? 'EMPATE' : 'PARTIDA ENCERRADA';
  $('result-emoji').textContent = win ? '🏆' : result === 'draw' ? '🤝' : '🎲';
  $('result-quote').textContent = win ? `"${WIN_QUOTE}"` : 'Boa partida! Veja como ficaram suas estatísticas.';
  document.querySelector('#screen-result .result').classList.toggle('neutral', !win);
  const box = $('result-stats');
  ui.clear(box);
  const stat = (n, label) => el('div', { class: 'stat' }, el('span', { class: 'stat-num', text: n }), el('span', { class: 'stat-label', text: label }));
  box.append(
    stat(formatDuration(duration), 'Duração da partida'),
    stat(String(plays), 'Quantidade de jogadas'),
    stat(resultText, 'Resultado'),
    stat(`${summary.wins}/${summary.played} (${summary.winRate}%)`, 'Vitórias / partidas'),
  );
  ui.setScreen('result');
}

/* -------------------------------------------------------------------------
 * Câmera e laço de reconhecimento
 * ----------------------------------------------------------------------- */
function videoEl() { return $('video'); }

function resetVideoUi() {
  $('video-placeholder').classList.remove('hidden');
  $('video-message').textContent = cameraSupport().supported
    ? 'Câmera desligada. Toque para ligar e permitir o acesso.'
    : cameraSupport().reason;
  $('btn-camera-start').disabled = !cameraSupport().supported;
  $('btn-camera-pause').textContent = 'Pausar câmera';
  setChip('chip-quality', 'Imagem: —', '');
  setChip('chip-recognition', 'Reconhecimento: —', '');
  $('quality-hints').textContent = '';
  $('still').classList.add('hidden');
  videoEl().classList.remove('hidden');
  app.stillMode = false;
}

function setChip(id, text, cls) {
  const c = $(id);
  c.textContent = text;
  c.className = `chip ${cls}`.trim();
}

async function startCamera(deviceId) {
  if (!app.camera) app.camera = createCamera({ video: videoEl() });
  app.stillMode = false;
  $('still').classList.add('hidden');
  videoEl().classList.remove('hidden');
  try {
    const info = await app.camera.start({ deviceId });
    $('video-placeholder').classList.add('hidden');
    if (info.width && info.height) $('video-wrap').style.aspectRatio = `${info.width} / ${info.height}`;
    app.camera.startLoop(onFrame, 4);
    $('btn-camera-pause').textContent = 'Pausar câmera';
  } catch (e) {
    $('video-placeholder').classList.remove('hidden');
    $('video-message').textContent = e.friendly || 'Não foi possível abrir a câmera.';
    ui.toast(e.friendly || 'Não foi possível abrir a câmera.', true, 5000);
  }
}

function stopCamera() {
  if (app.camera) app.camera.stop();
}

async function togglePause() {
  if (app.stillMode) { await startCamera(); return; }
  if (!app.camera || !app.camera.isActive()) { ui.toast('A câmera não está ligada.', true); return; }
  if (app.camera.isPaused()) { await app.camera.resume(); $('btn-camera-pause').textContent = 'Pausar câmera'; } else { app.camera.pause(); $('btn-camera-pause').textContent = 'Retomar câmera'; }
}

async function switchCamera() {
  if (!app.camera) app.camera = createCamera({ video: videoEl() });
  let devices = [];
  try { devices = await app.camera.devices(); } catch (e) { devices = []; }
  if (!devices.length) { ui.toast('Nenhuma câmera encontrada. Ligue a câmera primeiro para liberar a lista.', true, 4500); return; }
  ui.openChoice({
    title: 'Escolher câmera', text: 'Câmeras externas (USB) aparecem aqui quando conectadas.',
    choices: [...devices.map((d) => ({ label: d.label, kind: d.deviceId === app.camera.getDeviceId() ? 'primary' : 'ghost', onClick: () => startCamera(d.deviceId) })), { label: 'Cancelar', kind: 'ghost' }],
  });
}

function processSnapshot(frame) {
  const snap = app.recognizer.process(frame);
  app.snapshot = snap;
  const q = snap.quality;
  setChip('chip-quality', `Imagem: ${q.label} (${Math.round(q.score * 100)}%)`, q.label === 'boa' ? 'good' : q.label === 'média' ? 'mid' : 'bad');
  const total = snap.hand.length + snap.table.length;
  if (!total) setChip('chip-recognition', 'Reconhecimento: nenhuma peça', 'bad');
  else {
    const pct = Math.round(snap.recognitionRate * 100);
    setChip('chip-recognition', `Reconhecimento: ${pct}% (${total} peça${total > 1 ? 's' : ''})`, pct >= 80 ? 'good' : pct >= 50 ? 'mid' : 'bad');
  }
  const hints = q.hints.slice();
  if (snap.unresolved > 0) hints.push('Há peças encostadas em formato que não consigo separar (ex.: carroça atravessada). Afaste-as um pouco ou registre manualmente.');
  $('quality-hints').textContent = hints.join(' ');
  return snap;
}

async function onFrame() {
  if (document.hidden || app.stillMode || !app.camera) return;
  if (app.phase !== 'deal' && app.phase !== 'playing') return;
  const frame = app.camera.grabFrame(FRAME_WIDTH);
  if (!frame) return;
  const snap = processSnapshot(frame);
  if (app.phase === 'playing' && app.game) observeGame(snap);
  redrawOverlay();
}

function regionOf(geom, size) {
  const r = (geom.L + geom.W) / 2;
  return {
    x: Math.max(0, (geom.cx - r / 2 - geom.W / 4) / size.width), y: Math.max(0, (geom.cy - r / 2 - geom.W / 4) / size.height),
    w: Math.min(1, (r + geom.W / 2) / size.width), h: Math.min(1, (r + geom.W / 2) / size.height),
  };
}

function observeGame(snap) {
  const s = app.game;
  if (!s || s.status !== 'playing') return;

  if (s.board.length > 0 && snap.chainOrdered && snap.chainComplete && snap.chain.length > 0 && snap.chain.length <= s.board.length) {
    const observed = snap.chain.map((c) => ({ id: c.id, confidence: 1, verified: c.status === 'confirmed', moved: false, region: regionOf(c.geom, snap.frameSize) }));
    handleNewFindings(app.detector.observeBoard(s, observed));
  }

  const p = proposeEvents(s, snap);
  if (!p.events.length) {
    app.proposalKey = null; app.proposalCount = 0;
    $('proposal').classList.add('hidden');
    if (p.questions.length) $('quality-hints').textContent = `${$('quality-hints').textContent} ${p.questions[0]}`.trim();
    return;
  }
  const key = JSON.stringify(p.events);
  if (app.ignoredProposals.has(key)) { $('proposal').classList.add('hidden'); return; }
  if (key === app.proposalKey) app.proposalCount += 1; else { app.proposalKey = key; app.proposalCount = 1; }

  const verified = p.events.every((ev) => {
    const c = snap.chain.find((x) => x.id === ev.tileId);
    return !!c && c.status === 'confirmed';
  });
  if (p.autoApplicable && app.settings.autoApply && app.proposalCount >= AUTO_APPLY_FRAMES) {
    app.ignoredProposals.add(key);
    app.proposalKey = null; app.proposalCount = 0;
    $('proposal').classList.add('hidden');
    const ev = p.events[0];
    const c = snap.chain.find((x) => x.id === ev.tileId);
    const ok = commitEvent(ev, { verified, region: c ? regionOf(c.geom, snap.frameSize) : null });
    if (ok) ui.toast(`Jogada detectada: ${ui.describeEvent(ev, s.config)}.`);
    return;
  }
  if (app.proposalCount >= SHOW_PROPOSAL_FRAMES) showProposal(p, key, verified, snap);
}

function showProposal(p, key, verified, snap) {
  const box = $('proposal');
  ui.clear(box);
  box.classList.remove('hidden');
  const cfg = app.game.config;
  box.append(el('h3', { text: 'Jogada detectada pela câmera' }));
  p.events.forEach((ev) => box.append(el('p', { text: ui.describeEvent(ev, cfg) })));
  p.questions.forEach((q) => box.append(el('p', { class: 'note', text: q })));
  const row = el('div', { class: 'row wrap' });
  const apply = (events) => {
    app.ignoredProposals.add(key);
    $('proposal').classList.add('hidden');
    for (const ev of events) {
      const c = snap.chain.find((x) => x.id === ev.tileId);
      if (!commitEvent(ev, { verified, region: c ? regionOf(c.geom, snap.frameSize) : null })) break;
    }
  };
  if (p.events.length === 1) {
    const ev = p.events[0];
    for (let pl = 0; pl < cfg.players; pl += 1) {
      row.append(el('button', {
        class: `btn ${pl === ev.player ? 'btn-primary' : 'btn-ghost'} small`, type: 'button', text: ui.playerName(pl, cfg),
        onclick: () => apply([{ ...ev, player: pl }]),
      }));
    }
  } else {
    row.append(el('button', { class: 'btn btn-primary small', type: 'button', text: 'Confirmar jogadas', onclick: () => apply(p.events) }));
  }
  row.append(el('button', { class: 'btn btn-ghost small', type: 'button', text: 'Ignorar', onclick: () => { app.ignoredProposals.add(key); $('proposal').classList.add('hidden'); } }));
  box.append(row);
}

/* -------------------------------------------------------------------------
 * Sobreposição no vídeo e calibração
 * ----------------------------------------------------------------------- */
function redrawOverlay() {
  const canvas = $('overlay');
  if (!$('screen-game').classList.contains('active')) return;
  const showCal = !$('calibration-panel').classList.contains('hidden');
  ui.drawOverlay(canvas, {
    snapshot: app.snapshot,
    calibration: showCal ? app.calibration : null,
    recommendation: app.phase === 'playing' ? app.recommendation : null,
    calibrating: app.calibrating,
    state: app.game,
  });
}

function pointerNorm(e) {
  const r = $('overlay').getBoundingClientRect();
  return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
}

function bindCalibrationDrag() {
  const canvas = $('overlay');
  canvas.addEventListener('pointerdown', (e) => {
    if (!app.calibrating) return;
    canvas.setPointerCapture(e.pointerId);
    app.dragStart = pointerNorm(e);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!app.calibrating || !app.dragStart) return;
    const p = pointerNorm(e);
    const rect = { x: Math.min(app.dragStart.x, p.x), y: Math.min(app.dragStart.y, p.y), w: Math.abs(p.x - app.dragStart.x), h: Math.abs(p.y - app.dragStart.y) };
    if (rect.w > 0.03 && rect.h > 0.03) {
      app.calibration[app.calibrating === 'hand' ? 'handRegion' : 'tableRegion'] = rect;
      redrawOverlay();
    }
  });
  const end = () => {
    if (!app.dragStart) return;
    app.dragStart = null;
    if (app.recognizer) app.recognizer.setCalibration(app.calibration);
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
}

function toggleCalibration() {
  const panel = $('calibration-panel');
  const open = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !open);
  app.calibrating = open ? 'hand' : null;
  updateCalButtons();
  redrawOverlay();
}

function updateCalButtons() {
  $('cal-hand').className = `btn ${app.calibrating === 'hand' ? 'btn-primary' : 'btn-ghost'} small`;
  $('cal-table').className = `btn ${app.calibrating === 'table' ? 'btn-primary' : 'btn-ghost'} small`;
}

function currentFrame() {
  if (app.stillMode && app.stillFrame) return app.stillFrame;
  return app.camera && app.camera.isActive() ? app.camera.grabFrame(FRAME_WIDTH) : null;
}

function calibrateAuto() {
  const frame = currentFrame();
  const out = $('cal-result');
  if (!frame) { out.textContent = 'Ligue a câmera (ou importe uma foto) com as peças visíveis.'; return; }
  const res = autoCalibrate(frame, { maxPip: app.config ? app.config.maxPip : 6 });
  if (!res.ok) { out.textContent = res.message; return; }
  app.calibration = { ...app.calibration, tilePolarity: res.tilePolarity, thresholdOffset: res.thresholdOffset, calibrated: true };
  if (app.recognizer) app.recognizer.setCalibration(app.calibration);
  out.textContent = `Calibrado: ${res.tileCount} peça(s) reconhecida(s), peças ${res.tilePolarity === 'light' ? 'claras com pontos escuros' : 'escuras com pontos claros'}.`;
}

function saveCalibration() {
  store.set(CAL_KEY, JSON.stringify(app.calibration));
  $('calibration-panel').classList.add('hidden');
  app.calibrating = null;
  redrawOverlay();
  ui.toast('Calibração salva neste aparelho.');
}

function resetCalibration() {
  app.calibration = defaultCalibration();
  if (app.recognizer) app.recognizer.setCalibration(app.calibration);
  $('cal-result').textContent = 'Calibração restaurada.';
  redrawOverlay();
}

/* -------------------------------------------------------------------------
 * Correção manual do reconhecimento
 * ----------------------------------------------------------------------- */
function openCorrection() {
  const snap = app.snapshot;
  const body = el('div', {});
  const tracks = snap ? [...snap.hand.map((t) => ({ ...t, where: 'Mão' })), ...snap.table.map((t) => ({ ...t, where: 'Mesa' }))] : [];
  if (!tracks.length) body.append(el('p', { class: 'note', text: 'Nenhuma peça detectada no momento. Ligue a câmera, melhore a luz ou use o registro manual.' }));
  const labels = { stable: 'estável', confirmed: 'confirmada por você', uncertain: 'incerta', unread: 'ilegível', conflict: 'duplicada' };
  const maxPip = app.config ? app.config.maxPip : 6;
  for (const tr of tracks) {
    const cands = tr.candidates.map((c) => c.tileId);
    const row = el('div', { class: 'dash-item wide' },
      el('span', { text: `${tr.where} • peça #${tr.trackId} • ${labels[tr.status] || tr.status}` }),
      el('b', { text: tr.id ? fmtTile(tr.id) : cands.length ? `talvez ${cands.map(fmtTile).join(' ou ')}` : 'sem leitura' }),
      el('div', { class: 'row' },
        el('button', {
          class: 'btn btn-ghost small', type: 'button', text: 'Corrigir',
          onclick: () => { modal.close(); ui.openTilePicker({ title: `Qual é a peça #${tr.trackId}?`, maxPip, highlight: cands, onPick: (id) => { app.recognizer.confirm(tr.trackId, id); ui.toast(`Peça #${tr.trackId} definida como ${fmtTile(id)}.`); } }); },
        }),
        tr.status === 'confirmed' ? el('button', { class: 'btn btn-ghost small', type: 'button', text: 'Remover correção', onclick: () => { app.recognizer.confirm(tr.trackId, null); modal.close(); } }) : null));
    body.append(row);
  }
  const modal = ui.showModal({ title: 'Corrigir reconhecimento', body, actions: [{ label: 'Fechar', kind: 'ghost' }] });
}

/* -------------------------------------------------------------------------
 * Importar foto (alternativa para outro aparelho)
 * ----------------------------------------------------------------------- */
async function importPhoto(file) {
  try {
    const frame = await importImageFile(file, 1280);
    if (app.camera) app.camera.stopLoop();
    if (app.camera && app.camera.isActive()) app.camera.pause();
    app.stillMode = true;
    app.stillFrame = frame;
    const still = $('still');
    still.width = frame.width; still.height = frame.height;
    still.getContext('2d').putImageData(new ImageData(frame.data, frame.width, frame.height), 0, 0);
    still.classList.remove('hidden');
    videoEl().classList.add('hidden');
    $('video-placeholder').classList.add('hidden');
    $('video-wrap').style.aspectRatio = `${frame.width} / ${frame.height}`;
    app.recognizer.reset();
    for (let i = 0; i < AUTO_APPLY_FRAMES + 2; i += 1) {
      const snap = processSnapshot(frame);
      if (app.phase === 'playing' && app.game) observeGame(snap);
    }
    redrawOverlay();
    $('btn-camera-pause').textContent = 'Voltar à câmera';
    ui.toast('Foto analisada. Toque em "Voltar à câmera" para usar o vídeo ao vivo.');
  } catch (e) {
    ui.toast(e.message || 'Não foi possível ler a foto.', true);
  }
}

/* -------------------------------------------------------------------------
 * Ajustes
 * ----------------------------------------------------------------------- */
function openSettings() {
  const body = el('div', {});
  const toggle = (label, hint, key, onChange) => el('label', { class: 'toggle' },
    el('span', {}, label, el('div', { class: 'note', text: hint })),
    el('input', { type: 'checkbox', checked: app.settings[key] || null, onchange: (e) => { app.settings[key] = e.target.checked; store.set(SETTINGS_KEY, JSON.stringify(app.settings)); if (onChange) onChange(e.target.checked); } }));
  body.append(
    toggle('Aplicar jogadas detectadas automaticamente', 'Se desligado, você confirma cada jogada. Dá para desfazer a qualquer momento.', 'autoApply'),
    toggle('Permitir guardar capturas dos alertas', 'A imagem fica só na memória desta página, nunca é enviada nem salva sozinha. Você pode baixá-la.', 'allowSnapshots', (v) => { if (app.detector) app.detector.setSnapshotAllowed(v); renderAlertsPanel(); }),
  );
  ui.showModal({ title: 'Ajustes', body, actions: [{ label: 'Fechar', kind: 'primary' }] });
}

/* -------------------------------------------------------------------------
 * Estatísticas (painel)
 * ----------------------------------------------------------------------- */
function bindStatsPanel() {
  $('btn-stats-panel').addEventListener('click', () => {
    const p = $('stats-panel');
    p.classList.toggle('hidden');
    if (!p.classList.contains('hidden')) ui.renderStatsPanel(app.stats.getSummary());
  });
  $('btn-stats-reset').addEventListener('click', () => {
    ui.openChoice({
      title: 'Zerar estatísticas?', text: 'Isso apaga o histórico deste aparelho e não pode ser desfeito.',
      choices: [{ label: 'Zerar', kind: 'danger', onClick: () => { app.stats.reset(); refreshHome(); ui.toast('Estatísticas zeradas.'); } }, { label: 'Cancelar', kind: 'ghost' }],
    });
  });
  $('btn-stats-export').addEventListener('click', () => {
    const blob = new Blob([app.stats.exportJSON()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: 'xit-domino-estatisticas.json' });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  });
  $('btn-stats-import').addEventListener('click', () => $('file-stats-import').click());
  $('file-stats-import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const res = app.stats.importJSON(await file.text());
    if (res.ok) { refreshHome(); ui.toast('Estatísticas importadas.'); } else ui.toast(res.message, true);
    e.target.value = '';
  });
}

/* -------------------------------------------------------------------------
 * Inicialização
 * ----------------------------------------------------------------------- */
function bind() {
  $('btn-start').addEventListener('click', () => startWizard(null));
  $('btn-resume').addEventListener('click', resumeGame);
  $('btn-settings-home').addEventListener('click', openSettings);
  $('btn-settings-game').addEventListener('click', openSettings);
  $('setup-next').addEventListener('click', wizardNext);
  $('setup-back').addEventListener('click', wizardBack);

  $('btn-camera-start').addEventListener('click', () => startCamera());
  $('btn-camera-pause').addEventListener('click', togglePause);
  $('btn-calibrate').addEventListener('click', toggleCalibration);
  $('btn-correct').addEventListener('click', openCorrection);
  $('btn-switch-camera').addEventListener('click', switchCamera);
  $('btn-import-photo').addEventListener('click', () => $('file-photo').click());
  $('file-photo').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) importPhoto(f); e.target.value = ''; });

  $('cal-hand').addEventListener('click', () => { app.calibrating = 'hand'; updateCalButtons(); redrawOverlay(); });
  $('cal-table').addEventListener('click', () => { app.calibrating = 'table'; updateCalButtons(); redrawOverlay(); });
  $('cal-auto').addEventListener('click', calibrateAuto);
  $('cal-reset').addEventListener('click', resetCalibration);
  $('cal-save').addEventListener('click', saveCalibration);
  bindCalibrationDrag();

  $('deal-from-camera').addEventListener('click', dealFromCamera);
  $('deal-add-manual').addEventListener('click', dealAddManual);
  $('deal-clear').addEventListener('click', () => { app.dealHand = []; renderDeal(); });
  $('deal-start').addEventListener('click', dealStart);

  $('act-play').addEventListener('click', manualPlay);
  $('act-pass').addEventListener('click', manualPass);
  $('act-draw').addEventListener('click', () => manualDraw(null));
  $('act-undo').addEventListener('click', manualUndo);
  $('act-block').addEventListener('click', manualBlock);
  $('act-end').addEventListener('click', manualEnd);

  $('result-new').addEventListener('click', () => startWizard(app.config));
  $('result-home').addEventListener('click', goHome);
  bindStatsPanel();

  setInterval(() => {
    if (app.phase === 'playing' && $('screen-game').classList.contains('active')) {
      $('game-timer').textContent = ui.formatClock(elapsedMs());
      redrawOverlay();
    } else if (app.phase === 'deal') $('game-timer').textContent = '00:00';
  }, 500);

  window.addEventListener('resize', redrawOverlay);
  window.addEventListener('pagehide', () => { if (app.game && app.phase === 'playing') saveGame(); stopCamera(); });
}

function init() {
  bind();
  refreshHome();
  ui.setScreen('home');
  // gancho de teste/depuração (somente leitura do estado público)
  window.__xit = { app };
}

init();
