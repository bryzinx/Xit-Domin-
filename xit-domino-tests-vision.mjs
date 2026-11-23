/* XIT DOMINÓ — testes de visão e reconhecimento com cenas sintéticas. Execute: node tests/xit-domino-tests-vision.mjs */
import assert from 'node:assert/strict';
import { renderScene } from './xit-domino-test-utils.mjs';
import { analyzeFrame, autoCalibrate, frameQuality, toGray, otsu } from '../xit-domino-vision.js';
import { createRecognizer, orderChain, proposeEvents, suggestInitialHand, defaultCalibration } from '../xit-domino-recognition.js';
import { RULE_PRESETS, createGame, applyEvent } from '../xit-domino-engine.js';

let passed = 0;
function test(name, fn) { try { fn(); passed += 1; console.log('  ok  ', name); } catch (e) { console.error('  FAIL', name, '\n', e); process.exitCode = 1; } }
const deg = (d) => d * Math.PI / 180;
const pairs = []; for (let a = 0; a <= 6; a += 1) for (let b = a; b <= 6; b += 1) pairs.push([a, b]);
const sortedKey = (x, y) => (x <= y ? `${x}-${y}` : `${y}-${x}`);

function grid(opts = {}) {
  return pairs.map(([a, b], i) => ({ cx: 60 + (i % 7) * 88, cy: 60 + Math.floor(i / 7) * 110, angle: deg(((i * 37) % 180) - 90) * 0.9, L: opts.L || 78, a, b }));
}
function score(frame, tiles, vopts = {}) {
  const r = analyzeFrame(frame, vopts);
  let ok = 0; let wrong = 0; let miss = 0;
  for (const t of tiles) {
    const m = r.tiles.find((x) => Math.hypot(x.cx - t.cx, x.cy - t.cy) < 18);
    if (!m || !m.halves) { miss += 1; continue; }
    if (sortedKey(m.halves[0], m.halves[1]) === sortedKey(t.a, t.b)) ok += 1; else wrong += 1;
  }
  return { ok, wrong, miss, r };
}

/* ---------- visão ---------- */
test('28 peças com rotações variadas e ruído: todas lidas corretamente', () => {
  const tiles = grid();
  const s = score(renderScene(tiles, { noise: 6, seed: 3 }), tiles);
  assert.equal(s.wrong, 0); assert.equal(s.ok, 28);
});
test('nunca lê número errado em condições ruins (prefere não ler)', () => {
  const tiles = grid();
  const conds = [{ noise: 14, seed: 5 }, { blur: 1, noise: 8, seed: 6 }, { blur: 2, noise: 8, seed: 7 }, { noise: 25, seed: 8 }];
  for (const c of conds) {
    const s = score(renderScene(tiles, c), tiles);
    const confidentWrong = s.r.tiles.filter((t) => {
      const ref = tiles.find((x) => Math.hypot(x.cx - t.cx, x.cy - t.cy) < 18);
      return ref && t.halves && t.confidence >= 0.55 && sortedKey(t.halves[0], t.halves[1]) !== sortedKey(ref.a, ref.b);
    });
    assert.equal(confidentWrong.length, 0, `leitura errada com confiança alta em ${JSON.stringify(c)}`);
  }
});
test('peças escuras com pontos claros (calibração automática detecta a polaridade)', () => {
  const tiles = grid();
  const frame = renderScene(tiles, { noise: 5, seed: 9, table: [225, 220, 205], tile: [25, 25, 30], pip: [240, 240, 235] });
  const cal = autoCalibrate(frame);
  assert.ok(cal.ok); assert.equal(cal.tilePolarity, 'dark');
  const s = score(frame, tiles, { tilePolarity: cal.tilePolarity, thresholdOffset: cal.thresholdOffset });
  assert.equal(s.wrong, 0); assert.ok(s.ok >= 26, `ok=${s.ok}`);
});
test('calibração falha com cena sem peças em vez de inventar', () => {
  const cal = autoCalibrate(renderScene([], { noise: 4 }));
  assert.equal(cal.ok, false);
});
test('qualidade: imagem escura e borrada é pior que a nítida', () => {
  const tiles = grid();
  const good = analyzeFrame(renderScene(tiles, { noise: 3 })).quality;
  const dark = analyzeFrame(renderScene(tiles, { noise: 3, table: [3, 10, 6], tile: [40, 38, 34], pip: [5, 5, 5] })).quality;
  const blurry = analyzeFrame(renderScene(tiles, { noise: 3, blur: 3 })).quality;
  assert.ok(good.score > dark.score); assert.ok(good.score > blurry.score);
  assert.ok(dark.hints.some((h) => /luz/i.test(h)));
});
test('peças de tamanhos diferentes (câmera mais perto/longe)', () => {
  for (const L of [60, 110]) {
    const tiles = pairs.slice(0, 8).map(([a, b], i) => ({ cx: 80 + (i % 4) * 150, cy: 90 + Math.floor(i / 4) * 200, angle: deg(i * 20), L, a, b }));
    const s = score(renderScene(tiles, { noise: 5, seed: 11, width: 700, height: 500 }), tiles);
    assert.equal(s.wrong, 0, `L=${L}`); assert.ok(s.ok >= 7, `L=${L} ok=${s.ok}`);
  }
});

/* ---------- cadeia ---------- */
function chainScene(spec, gap = 2, angle = 0, start = { x: 60, y: 200 }) {
  // spec: [{a,b,flip}]; peças em linha, "a" fica na esquerda (u<0) salvo flip
  const L = 80; const tiles = []; let x = start.x + L / 2;
  for (const s of spec) {
    tiles.push({ cx: x, cy: start.y, angle: s.flip ? Math.PI : 0, L, a: s.a, b: s.b });
    x += L + gap;
  }
  return tiles;
}
function feed(rec, frame, times = 5) { let snap; for (let i = 0; i < times; i += 1) snap = rec.process(frame); return snap; }
const calAll = { ...defaultCalibration(), handRegion: { x: 0, y: 0.7, w: 1, h: 0.3 }, tableRegion: { x: 0, y: 0, w: 1, h: 0.7 } };

test('cadeia em linha: ordem, orientação e encaixes corretos (peças viradas)', () => {
  // 2|3  3|3  3|5(flip => 5 na esquerda? usa a=5,b=3 com flip) ...
  const spec = [{ a: 2, b: 3 }, { a: 3, b: 3 }, { a: 5, b: 3, flip: true }, { a: 5, b: 1 }];
  const tiles = chainScene(spec, 2);
  const frame = renderScene(tiles, { noise: 4, seed: 21 });
  const rec = createRecognizer(RULE_PRESETS.brasileiro, { calibration: calAll });
  const snap = feed(rec, frame);
  assert.ok(snap.chainOrdered); assert.ok(snap.chainComplete);
  assert.deepEqual(snap.chain.map((c) => c.id), ['2-3', '3-3', '3-5', '1-5']);
  assert.deepEqual(snap.chain.map((c) => [c.left, c.right]), [[2, 3], [3, 3], [3, 5], [5, 1]]);
  assert.equal(snap.chainProblems.length, 0);
});
test('cadeia encostada (sem vãos) também é separada por tamanho', () => {
  const spec = [{ a: 6, b: 6 }, { a: 6, b: 2 }, { a: 2, b: 0 }];
  const frame = renderScene(chainScene(spec, 0), { noise: 3, seed: 22 });
  const rec = createRecognizer(RULE_PRESETS.brasileiro, { calibration: calAll });
  const snap = feed(rec, frame);
  assert.deepEqual(snap.chain.map((c) => c.id), ['6-6', '2-6', '0-2']);
});
test('cadeia inclinada: ordem esquerda→direita mantida', () => {
  const L = 80; const a = deg(25); const tiles = [];
  const seq = [[1, 2], [2, 4], [4, 4], [4, 0]];
  seq.forEach(([x, y], i) => { const d = i * (L + 2) + L / 2; tiles.push({ cx: 90 + d * Math.cos(a), cy: 120 + d * Math.sin(a), angle: a, L, a: x, b: y }); });
  const rec = createRecognizer(RULE_PRESETS.brasileiro, { calibration: calAll });
  const snap = feed(rec, renderScene(tiles, { noise: 4, seed: 23 }));
  assert.deepEqual(snap.chain.map((c) => [c.left, c.right]), seq);
});
test('carroça atravessada no meio da cadeia', () => {
  const L = 80; const W = 40;
  const tiles = [
    { cx: 100, cy: 200, angle: 0, L, a: 1, b: 3 },
    { cx: 100 + L / 2 + W / 2 + 6, cy: 200, angle: Math.PI / 2, L, a: 3, b: 3 },
    { cx: 100 + L / 2 + W + 12 + L / 2, cy: 200, angle: 0, L, a: 3, b: 5 },
  ];
  const rec = createRecognizer(RULE_PRESETS.brasileiro, { calibration: calAll });
  const snap = feed(rec, renderScene(tiles, { noise: 3, seed: 24 }));
  assert.deepEqual(snap.chain.map((c) => c.id), ['1-3', '3-3', '3-5']);
  assert.deepEqual(snap.chain.map((c) => [c.left, c.right]), [[1, 3], [3, 3], [3, 5]]);
});
test('carroça atravessada ENCOSTADA (bloco em forma de cruz) não é inventada: vira "não resolvido"', () => {
  const L = 80; const W = 40;
  const tiles = [
    { cx: 100, cy: 200, angle: 0, L, a: 1, b: 3 },
    { cx: 100 + L / 2 + W / 2, cy: 200, angle: Math.PI / 2, L, a: 3, b: 3 },
    { cx: 100 + L / 2 + W + L / 2, cy: 200, angle: 0, L, a: 3, b: 5 },
  ];
  const r = analyzeFrame(renderScene(tiles, { noise: 3, seed: 25 }), {});
  assert.ok(r.unresolved >= 1);
  assert.ok(r.tiles.every((t) => !t.halves || t.confidence < 0.45 || tiles.some((x) => Math.hypot(x.cx - t.cx, x.cy - t.cy) < 25)));
});
test('leitura que não encaixa gera problema (não é escondida)', () => {
  const items = [
    { trackId: 1, id: '1-2', halves: [1, 2], tileStatus: 'stable', geom: { cx: 100, cy: 100, W: 40, L: 80, dir: { x: 1, y: 0 }, endA: { x: 60, y: 100 }, endB: { x: 140, y: 100 } } },
    { trackId: 2, id: '3-4', halves: [3, 4], tileStatus: 'stable', geom: { cx: 182, cy: 100, W: 40, L: 80, dir: { x: 1, y: 0 }, endA: { x: 142, y: 100 }, endB: { x: 222, y: 100 } } },
  ];
  const r = orderChain(items);
  assert.equal(r.problems.length, 1); assert.equal(r.problems[0].type, 'mismatch');
});

/* ---------- rastreio, estabilidade e confirmação ---------- */
test('peça só fica estável após leituras repetidas; antes é incerta', () => {
  const tiles = [{ cx: 200, cy: 150, angle: 0, L: 80, a: 4, b: 5 }];
  const frame = renderScene(tiles, { noise: 4, seed: 31 });
  const rec = createRecognizer(RULE_PRESETS.brasileiro, { calibration: calAll });
  const s1 = rec.process(frame);
  assert.equal(s1.table[0].status, 'uncertain');
  const s5 = feed(rec, frame, 4);
  assert.equal(s5.table[0].status, 'stable'); assert.equal(s5.table[0].id, '4-5');
});
test('zona: peças em baixo vão para a mão e em cima para a mesa', () => {
  const tiles = [{ cx: 200, cy: 100, angle: 0, L: 80, a: 1, b: 1 }, { cx: 200, cy: 420, angle: 0, L: 80, a: 6, b: 2 }];
  const rec = createRecognizer(RULE_PRESETS.brasileiro, { calibration: calAll });
  const snap = feed(rec, renderScene(tiles, { noise: 3, seed: 32 }));
  assert.deepEqual(snap.handIds, ['2-6']); assert.deepEqual(snap.chain.map((c) => c.id), ['1-1']);
});
test('peça ilegível não recebe número; confirmação manual resolve', () => {
  const tiles = [{ cx: 200, cy: 150, angle: 0, L: 80, a: 3, b: 6 }];
  const frame = renderScene(tiles, { noise: 60, blur: 2, seed: 33 });
  const rec = createRecognizer(RULE_PRESETS.brasileiro, { calibration: calAll });
  const snap = feed(rec, frame, 6);
  const tr = snap.table[0];
  if (tr) assert.ok(tr.status !== 'stable' || tr.id === '3-6', 'estável com número errado');
  const tid = tr ? tr.trackId : null;
  if (tid) { assert.ok(rec.confirm(tid, '3-6')); assert.equal(rec.process(frame).table[0].id, '3-6'); assert.ok(!rec.confirm(tid, '9-9')); }
});
test('mesma peça em dois lugares vira conflito', () => {
  const tiles = [{ cx: 120, cy: 100, angle: 0, L: 80, a: 2, b: 5 }, { cx: 420, cy: 200, angle: 0, L: 80, a: 2, b: 5 }];
  const rec = createRecognizer(RULE_PRESETS.brasileiro, { calibration: calAll });
  const snap = feed(rec, renderScene(tiles, { noise: 3, seed: 34 }));
  assert.ok(snap.table.every((d) => d.status === 'conflict'));
  assert.ok(snap.needsConfirmation.length === 2);
});
test('mão inicial sugerida só quando completa e certa', () => {
  const hand = [['6', '6'], ['5', '3'], ['4', '2'], ['1', '0'], ['4', '4'], ['2', '2']].map(([a, b], i) => ({ cx: 70 + i * 100, cy: 420, angle: deg(i * 7), L: 80, a: +a, b: +b }));
  const rec = createRecognizer(RULE_PRESETS.brasileiro, { calibration: calAll });
  const snap = feed(rec, renderScene(hand, { noise: 4, seed: 35 }));
  const sug = suggestInitialHand(snap, 6);
  assert.ok(sug.ok, sug.message); assert.deepEqual(sug.ids, ['0-1', '2-2', '2-4', '3-5', '4-4', '6-6']);
  assert.ok(!suggestInitialHand(snap, 7).ok);
});

/* ---------- propostas de jogada ---------- */
function gameWith(hand = ['6-6', '6-3', '5-3', '2-2', '0-1', '4-5']) { return createGame(RULE_PRESETS.brasileiro, { myHand: hand }).state; }
const obsOf = (spec) => { const rec = createRecognizer(RULE_PRESETS.brasileiro, { calibration: calAll }); return feed(rec, renderScene(chainScene(spec, 2), { noise: 3, seed: 40 })); };

test('mesa vazia + uma peça nova = propõe abertura automática', () => {
  const p = proposeEvents(gameWith(), obsOf([{ a: 6, b: 6 }]));
  assert.equal(p.events.length, 1); assert.deepEqual(p.events[0], { type: 'play', player: 0, tileId: '6-6', end: 'start' });
  assert.ok(p.autoApplicable);
});
test('nova peça à direita e à esquerda são distinguidas e aplicáveis no motor', () => {
  let s = gameWith();
  s = applyEvent(s, { type: 'play', player: 0, tileId: '6-6' }).state;
  const right = proposeEvents(s, obsOf([{ a: 6, b: 6 }, { a: 6, b: 1 }]));
  assert.deepEqual(right.events[0], { type: 'play', player: 1, tileId: '1-6', end: 'right' });
  const left = proposeEvents(s, obsOf([{ a: 2, b: 6 }, { a: 6, b: 6 }]));
  assert.deepEqual(left.events[0], { type: 'play', player: 1, tileId: '2-6', end: 'left' });
  assert.ok(applyEvent(s, right.events[0]).ok); assert.ok(applyEvent(s, left.events[0]).ok);
});
test('minha peça jogada é atribuída a mim; mesa igual ao histórico não propõe nada', () => {
  let s = gameWith();
  s = applyEvent(s, { type: 'play', player: 0, tileId: '6-6' }).state;
  s = applyEvent(s, { type: 'play', player: 1, tileId: '1-6', end: 'right' }).state;
  s = applyEvent(s, { type: 'play', player: 2, tileId: '1-1', end: 'right' }).state;
  s = applyEvent(s, { type: 'play', player: 3, tileId: '1-2', end: 'right' }).state;
  const p = proposeEvents(s, obsOf([{ a: 6, b: 6 }, { a: 6, b: 1 }, { a: 1, b: 1 }, { a: 1, b: 2 }, { a: 2, b: 5 }]));
  // 2-5 não é minha, é a minha vez -> pede confirmação
  assert.equal(p.autoApplicable, false);
  const none = proposeEvents(s, obsOf([{ a: 6, b: 6 }, { a: 6, b: 1 }, { a: 1, b: 1 }, { a: 1, b: 2 }]));
  assert.equal(none.events.length, 0);
});
test('mesa que não bate com o histórico gera pergunta, não evento', () => {
  let s = gameWith();
  s = applyEvent(s, { type: 'play', player: 0, tileId: '6-6' }).state;
  const p = proposeEvents(s, obsOf([{ a: 5, b: 5 }, { a: 5, b: 1 }]));
  assert.equal(p.events.length, 0); assert.ok(p.questions.length > 0);
});

console.log(`\n${passed} testes passaram${process.exitCode ? ' (HÁ FALHAS)' : ''}.`);
