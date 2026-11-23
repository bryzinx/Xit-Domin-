/* XIT DOMINÓ — testes da Etapa 2 (estatísticas e detector). Execute: node tests/xit-domino-tests-stage2.mjs */
import assert from 'node:assert/strict';
import { RULE_PRESETS, createGame, applyEvent } from '../xit-domino-engine.js';
import { createStatsStore, createMemoryStorage, formatDuration, resultFromGame, STATS_KEY } from '../xit-domino-stats.js';
import { createCheatDetector, alertLabel, LEVEL } from '../xit-domino-cheat-detector.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log('  ok  ', name); } catch (e) { console.error('  FAIL', name, '\n', e); process.exitCode = 1; }
}
const play = (s, player, id, end) => { const r = applyEvent(s, { type: 'play', player, tileId: id, end }); assert.ok(r.ok, r.error && r.error.message); return r.state; };
const base = () => createGame(RULE_PRESETS.brasileiro, { myHand: ['6-6', '6-3', '5-3', '2-2', '0-1', '4-5'] }).state;

/* ---------- estatísticas ---------- */
test('estatísticas começam zeradas e taxa de vitória é 0 sem partidas', () => {
  const st = createStatsStore(createMemoryStorage());
  const s = st.getSummary();
  assert.equal(s.played, 0); assert.equal(s.winRate, 0); assert.equal(s.totalTimeText, '0s');
});
test('registra vitórias, derrotas, empates, tempo e acompanhadas', () => {
  const st = createStatsStore(createMemoryStorage());
  st.recordTracked(); st.recordTracked(); st.recordTracked();
  st.recordGame({ result: 'win', durationMs: 600000, moves: 12, modality: 'Brasileiro' });
  st.recordGame({ result: 'loss', durationMs: 300000, moves: 9 });
  st.recordGame({ result: 'abandoned', durationMs: 60000 });
  const s = st.getSummary();
  assert.equal(s.tracked, 3); assert.equal(s.played, 2); assert.equal(s.wins, 1); assert.equal(s.losses, 1);
  assert.equal(s.winRate, 50); assert.equal(s.totalTimeMs, 960000); assert.equal(s.totalTimeText, '16min 00s');
  assert.equal(s.history.length, 3);
});
test('dados persistem entre sessões (mesmo armazenamento)', () => {
  const storage = createMemoryStorage();
  const a = createStatsStore(storage);
  a.recordGame({ result: 'win', durationMs: 1000 });
  const b = createStatsStore(storage);
  assert.equal(b.getSummary().wins, 1);
  assert.ok(storage.getItem(STATS_KEY));
});
test('dados corrompidos ou adulterados não quebram', () => {
  const storage = createMemoryStorage();
  storage.setItem(STATS_KEY, '{lixo');
  assert.equal(createStatsStore(storage).getSummary().played, 0);
  storage.setItem(STATS_KEY, JSON.stringify({ version: 1, wins: -5, losses: 'x', played: 999, totalTimeMs: 'a', history: [{ result: 'hack' }] }));
  const s = createStatsStore(storage).getSummary();
  assert.equal(s.wins, 0); assert.equal(s.played, 0); assert.equal(s.history.length, 0);
});
test('resultado inválido é rejeitado e falha de gravação é sinalizada', () => {
  const st = createStatsStore(createMemoryStorage());
  assert.throws(() => st.recordGame({ result: 'ganhou', durationMs: 1 }));
  const broken = { getItem: () => null, setItem: () => { throw new Error('cheio'); }, removeItem: () => {} };
  const st2 = createStatsStore(broken);
  const s = st2.recordGame({ result: 'win', durationMs: 5 });
  assert.equal(s.persistent, false); assert.ok(s.lastError);
  assert.equal(s.wins, 1);
});
test('reset, exportar e importar', () => {
  const st = createStatsStore(createMemoryStorage());
  st.recordGame({ result: 'win', durationMs: 1000 });
  const dump = st.exportJSON();
  st.reset();
  assert.equal(st.getSummary().played, 0);
  assert.ok(st.importJSON(dump).ok);
  assert.equal(st.getSummary().wins, 1);
  assert.ok(!st.importJSON('x').ok);
  assert.ok(!st.importJSON('{"version":2}').ok);
});
test('formatDuration', () => {
  assert.equal(formatDuration(45000), '45s'); assert.equal(formatDuration(125000), '2min 05s'); assert.equal(formatDuration(3900000), '1h 05min');
  assert.equal(formatDuration(-1), '0s'); assert.equal(formatDuration(NaN), '0s');
});
test('resultFromGame: bateu (eu/parceiro/adversário) e jogo fechado', () => {
  let s = createGame({ ...RULE_PRESETS.individual4, handSize: 1 }, { myHand: ['6-6'] }).state;
  assert.equal(resultFromGame(applyEvent(s, { type: 'play', player: 0, tileId: '6-6' }).state), 'win');
  const t = { status: 'finished', winner: 2, config: RULE_PRESETS.brasileiro };
  assert.equal(resultFromGame(t), 'win');
  assert.equal(resultFromGame({ ...t, winner: 1 }), 'loss');
  assert.equal(resultFromGame({ status: 'blocked', config: RULE_PRESETS.brasileiro }), null);
  assert.equal(resultFromGame({ status: 'blocked', config: RULE_PRESETS.brasileiro }, 'draw'), 'draw');
  assert.equal(resultFromGame({ status: 'playing', config: RULE_PRESETS.brasileiro }), null);
});

/* ---------- detector ---------- */
test('jogada válida não gera achados', () => {
  const d = createCheatDetector();
  let s = base();
  const r = d.checkEvent(s, { type: 'play', player: 0, tileId: '6-6', end: 'left' });
  assert.ok(r.ok); assert.equal(r.findings.length, 0); assert.equal(d.list().length, 0);
});
test('peça sem correspondência: suspeita, e confirmada só se verificada', () => {
  let s = play(base(), 0, '6-6', 'left');
  const d = createCheatDetector();
  const r = d.checkEvent(s, { type: 'play', player: 1, tileId: '1-2', end: 'left' });
  assert.ok(!r.ok); assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].level, LEVEL.SUSPECT);
  assert.equal(alertLabel(r.findings[0]), 'IRREGULARIDADE SUSPEITA — REVISAR');
  const d2 = createCheatDetector();
  const r2 = d2.checkEvent(s, { type: 'play', player: 1, tileId: '1-2', end: 'left' }, { verified: true, region: { x: .1, y: .1, w: .2, h: .2 } });
  assert.equal(r2.findings[0].level, LEVEL.CONFIRMED);
  assert.equal(alertLabel(r2.findings[0]), 'TRAPAÇA DETECTADA');
  assert.deepEqual(r2.findings[0].region, { x: .1, y: .1, w: .2, h: .2 });
});
test('achado do mesmo evento não se repete', () => {
  let s = play(base(), 0, '6-6', 'left');
  const d = createCheatDetector();
  d.checkEvent(s, { type: 'play', player: 1, tileId: '1-2', end: 'left' });
  d.checkEvent(s, { type: 'play', player: 1, tileId: '1-2', end: 'left' });
  assert.equal(d.list().length, 1);
});
test('jogar número que o jogador já tinha passado gera alerta; fora da vez é sempre suspeita', () => {
  let s = play(base(), 0, '6-6', 'left');
  s = applyEvent(s, { type: 'pass', player: 1 }).state;      // 1 não tem 6
  const d = createCheatDetector();
  const r = d.checkEvent(s, { type: 'play', player: 2, tileId: '6-0', end: 'left' }, { verified: true });
  assert.equal(r.findings.length, 0);                          // jogador 2 não passou
  const r2 = d.checkEvent(s, { type: 'play', player: 1, tileId: '6-0', end: 'left' }, { verified: true });
  const kinds = r2.findings.map((f) => f.kind).sort();
  assert.ok(kinds.includes('missing-number'));
  const oot = r2.findings.find((f) => f.kind === 'out-of-turn');
  assert.ok(oot && oot.level === LEVEL.SUSPECT);               // jogador 1 jogou fora da vez (era do 2)
  assert.equal(r2.findings.find((f) => f.kind === 'missing-number').level, LEVEL.CONFIRMED);
});
test('observação da câmera: só alerta depois de quadros estáveis', () => {
  const s = play(base(), 0, '6-6', 'left');
  const d = createCheatDetector({ stableFrames: 4 });
  const bad = [{ id: '5-5', confidence: 0.95 }];
  for (let i = 0; i < 3; i += 1) assert.equal(d.observeBoard(s, bad).length, 0);
  const made = d.observeBoard(s, bad);
  assert.equal(made.length, 1); assert.equal(made[0].kind, 'tile-changed'); assert.equal(made[0].level, LEVEL.SUSPECT);
  assert.equal(d.observeBoard(s, bad).length, 0);              // não repete
});
test('observação instável ou de baixa confiança não gera alerta', () => {
  const s = play(base(), 0, '6-6', 'left');
  const d = createCheatDetector({ stableFrames: 3 });
  for (let i = 0; i < 20; i += 1) {
    const obs = i % 2 ? [{ id: '5-5', confidence: 0.95 }] : [{ id: '6-6', confidence: 0.95 }];
    assert.equal(d.observeBoard(s, obs).length, 0);
  }
  for (let i = 0; i < 10; i += 1) assert.equal(d.observeBoard(s, [{ id: '5-5', confidence: 0.4 }]).length, 0);
  assert.equal(d.list().length, 0);
});
test('peça movimentada após colocada vira possível substituição; mesa com menos peças e duplicata observada', () => {
  let s = play(base(), 0, '6-6', 'left');
  s = play(s, 1, '6-1', 'right');
  const d = createCheatDetector({ stableFrames: 2 });
  const sub = [{ id: '6-6', confidence: .95 }, { id: '6-2', confidence: .95, moved: true }];
  d.observeBoard(s, sub);
  assert.equal(d.observeBoard(s, sub)[0].kind, 'tile-substitution');
  const d2 = createCheatDetector({ stableFrames: 2 });
  d2.observeBoard(s, [{ id: '6-6', confidence: .95 }]);
  assert.equal(d2.observeBoard(s, [{ id: '6-6', confidence: .95 }])[0].kind, 'tile-missing');
  const d3 = createCheatDetector({ stableFrames: 2 });
  const dup = [{ id: '6-6', confidence: .95 }, { id: '6-6', confidence: .95 }];
  d3.observeBoard(s, dup);
  assert.ok(d3.observeBoard(s, dup).some((f) => f.kind === 'duplicate-observed'));
});
test('mesa observada igual à registrada (ou com peça nova ainda não registrada) não alerta', () => {
  let s = play(base(), 0, '6-6', 'left');
  s = play(s, 1, '6-1', 'right');
  const d = createCheatDetector({ stableFrames: 1 });
  assert.equal(d.observeBoard(s, [{ id: '6-6', confidence: .95 }, { id: '1-6', confidence: .95 }]).length, 0);
  assert.equal(d.observeBoard(s, [{ id: '6-6', confidence: .95 }, { id: '1-6', confidence: .95 }, { id: '1-4', confidence: .95 }]).length, 0);
});
test('dispensar, revisar manualmente e regras de captura de imagem', () => {
  let s = play(base(), 0, '6-6', 'left');
  const d = createCheatDetector();
  const f = d.checkEvent(s, { type: 'play', player: 1, tileId: '1-2', end: 'left' }).findings[0];
  assert.equal(d.attachSnapshot(f.id, 'data:image/jpeg;base64,AAA'), false);   // sem autorização
  d.setSnapshotAllowed(true);
  assert.equal(d.attachSnapshot(f.id, 'http://site.com/x.jpg'), false);        // só data URL de imagem
  assert.equal(d.attachSnapshot(f.id, 'data:image/jpeg;base64,AAA'), true);
  assert.ok(!('snapshot' in d.toJSON()[0]));                                    // exportação sem imagem
  d.setSnapshotAllowed(false);
  assert.equal(d.get(f.id).snapshot, null);                                     // revogar apaga capturas
  assert.equal(d.open().length, 1);
  assert.ok(d.review(f.id, 'confirmed')); assert.equal(d.get(f.id).level, LEVEL.CONFIRMED);
  assert.ok(d.dismiss(f.id)); assert.equal(d.open().length, 0);
  assert.ok(!d.dismiss('nao-existe')); assert.ok(!d.review(f.id, 'x'));
  d.reset(); assert.equal(d.list().length, 0);
});

console.log(`\n${passed} testes passaram${process.exitCode ? ' (HÁ FALHAS)' : ''}.`);
