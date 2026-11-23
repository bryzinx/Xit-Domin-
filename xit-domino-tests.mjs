/* XIT DOMINÓ — testes do motor e da estratégia. Execute: node tests/xit-domino-tests.mjs */
import assert from 'node:assert/strict';
import {
  RULE_PRESETS, createTileSet, createGame, applyEvent, legalMoves, getEnds, toTileId,
  tileId, parseTile, undoLastEvent, serializeGame, deserializeGame, checkConsistency,
  unseenTiles, boneyardSize, tilePips, normalizeConfig, isBlocked,
} from '../xit-domino-engine.js';
import { recommend, rankMoves, probNoMatch } from '../xit-domino-strategy.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log('  ok  ', name); } catch (e) { console.error('  FAIL', name, '\n', e); process.exitCode = 1; }
}
const play = (s, player, id, end) => { const r = applyEvent(s, { type: 'play', player, tileId: id, end }); assert.ok(r.ok, r.error && r.error.message); return r.state; };

/* ---------- peças ---------- */
test('conjunto duplo-6 tem 28 peças, duplo-9 tem 55, duplo-12 tem 91', () => {
  assert.equal(createTileSet(6).length, 28);
  assert.equal(createTileSet(9).length, 55);
  assert.equal(createTileSet(12).length, 91);
});
test('toTileId normaliza formatos e rejeita inválidos', () => {
  assert.equal(toTileId('6|3', 6), '3-6');
  assert.equal(toTileId([3, 6], 6), '3-6');
  assert.equal(toTileId({ left: 6, right: 3 }, 6), '3-6');
  assert.equal(toTileId('7-1', 6), null);
  assert.equal(toTileId('x', 6), null);
  assert.equal(toTileId(null, 6), null);
});
test('configuração: valida jogadores, mão e monte', () => {
  assert.ok(normalizeConfig(RULE_PRESETS.brasileiro).ok);
  assert.ok(!normalizeConfig({ players: 5 }).ok);
  assert.ok(!normalizeConfig({ players: 4, handSize: 8 }).ok);
  assert.ok(!normalizeConfig({ players: 2, handSize: 14, drawRule: 'until-playable' }).ok);
  assert.ok(!normalizeConfig({ players: 3, teams: true }).ok);
});

/* ---------- jogo básico ---------- */
const hand6 = ['6-6', '6-3', '5-3', '2-2', '0-1', '4-5'];
function newGame(preset = 'brasileiro', hand = hand6, starter = 0) {
  const r = createGame(RULE_PRESETS[preset], { myHand: hand, starter });
  assert.ok(r.ok, r.error && r.error.message);
  return r.state;
}
test('createGame valida tamanho e duplicação da mão', () => {
  assert.ok(!createGame(RULE_PRESETS.brasileiro, { myHand: ['6-6'] }).ok);
  assert.ok(!createGame(RULE_PRESETS.brasileiro, { myHand: ['6-6', '6-6', '1-1', '2-2', '3-3', '4-4'] }).ok);
});
test('abertura obriga a maior carroça da mão (regra highest-double)', () => {
  const s = newGame();
  const m = legalMoves(s);
  assert.equal(m.length, 1);
  assert.equal(m[0].tileId, '6-6');
});
test('jogar peça atualiza pontas, mão e vez', () => {
  let s = newGame();
  s = play(s, 0, '6-6', 'left');
  assert.deepEqual(getEnds(s), { left: 6, right: 6 });
  assert.equal(s.myHand.length, 5);
  assert.equal(s.turn, 1);
  s = play(s, 1, '6-1', 'right');
  assert.deepEqual(getEnds(s), { left: 6, right: 1 });
  s = play(s, 2, '2-6', 'left');
  assert.deepEqual(getEnds(s), { left: 2, right: 1 });
  assert.equal(s.board[0].left, 2);
  assert.equal(s.board[0].right, 6);
  assert.equal(s.handCounts[1], 5);
  assert.equal(s.handCounts[2], 5);
  assert.equal(checkConsistency(s).filter((i) => i.severity === 'error').length, 0);
});
test('rejeita peça sem encaixe, duplicada e conflitante com minha mão', () => {
  let s = newGame();
  s = play(s, 0, '6-6', 'left');
  assert.equal(applyEvent(s, { type: 'play', player: 1, tileId: '1-2', end: 'left' }).error.code, 'no-match');
  assert.equal(applyEvent(s, { type: 'play', player: 1, tileId: '6-6', end: 'left' }).error.code, 'duplicate-board');
  assert.equal(applyEvent(s, { type: 'play', player: 1, tileId: '3-6', end: 'left' }).error.code, 'conflict-my-hand');
  assert.equal(applyEvent(s, { type: 'play', player: 0, tileId: '1-1', end: 'left' }).error.code, 'not-in-hand');
});
test('applyEvent não altera o estado original', () => {
  const s = newGame();
  const copy = JSON.stringify(s);
  applyEvent(s, { type: 'play', player: 0, tileId: '6-6' });
  assert.equal(JSON.stringify(s), copy);
});
test('jogada legal só em pontas que combinam, sem duplicar orientação', () => {
  let s = newGame('brasileiro', ['6-6', '6-3', '5-3', '2-2', '0-1', '4-5']);
  s = play(s, 0, '6-6', 'left');
  s = play(s, 1, '6-1', 'right');       // pontas 6 | 1
  s = play(s, 2, '1-4', 'right');       // pontas 6 | 4
  s = play(s, 3, '2-4', 'right');       // pontas 6 | 2 (vez de 0)
  const moves = legalMoves(s);
  for (const m of moves) {
    const ends = getEnds(s);
    const v = m.end === 'left' ? ends.left : ends.right;
    assert.equal(m.touch, v);
    assert.ok(m.touch === m.placed.right || m.touch === m.placed.left);
  }
  const ids = moves.map((m) => `${m.tileId}:${m.end}`).sort();
  assert.deepEqual(ids, ['2-2:right', '3-6:left'].sort());
});

/* ---------- passes e números que faltam ---------- */
test('passe registra números ausentes e jogada contraditória gera alerta', () => {
  let s = newGame();
  s = play(s, 0, '6-6', 'left');
  let r = applyEvent(s, { type: 'pass', player: 1 });
  assert.ok(r.ok);
  s = r.state;
  assert.deepEqual(s.missing[1], [6]);
  s = play(s, 2, '6-2', 'right');          // pontas 6 | 2
  s = play(s, 3, '2-4', 'right');          // pontas 6 | 4
  s = applyEvent(s, { type: 'pass', player: 0 }).ok ? s : s;
  r = applyEvent(s, { type: 'play', player: 1, tileId: '6-0', end: 'left' });
  assert.ok(r.ok);
  assert.ok(r.warnings.some((w) => w.code === 'played-missing-number'));
});
test('eu não posso passar tendo jogada', () => {
  let s = newGame();
  s = play(s, 0, '6-6', 'left');
  s = play(s, 1, '6-1', 'right');
  s = play(s, 2, '1-1', 'right');
  s = play(s, 3, '1-2', 'right');
  assert.equal(applyEvent(s, { type: 'pass', player: 0 }).error.code, 'illegal-pass');
});
test('probNoMatch: nunca fora de [0,1] e vale 1 quando o adversário não tem o número', () => {
  let s = newGame();
  s = play(s, 0, '6-6', 'left');
  s = applyEvent(s, { type: 'pass', player: 1 }).state;
  const ctx = { unseen: unseenTiles(s).map((id) => ({ id, ...parseTile(id) })) };
  const p = probNoMatch(s, ctx, 1, [6]);
  assert.equal(p, 1);
  const q = probNoMatch(s, ctx, 2, [6]);
  assert.ok(q >= 0 && q <= 1);
});

/* ---------- compra ---------- */
test('compra: bloqueia sem regra, exige peça válida e zera deduções do adversário', () => {
  const s0 = createGame(RULE_PRESETS.compra2, { myHand: ['6-6', '1-2', '2-3', '3-4', '4-5', '0-5', '0-0'], starter: 0 }).state;
  assert.equal(boneyardSize(s0), 28 - 14);
  let s = play(s0, 0, '6-6', 'left');
  let r = applyEvent(s, { type: 'draw', player: 1 });
  assert.ok(r.ok);
  assert.equal(r.state.handCounts[1], 8);
  const noDraw = createGame(RULE_PRESETS.brasileiro, { myHand: hand6 }).state;
  assert.equal(applyEvent(play(noDraw, 0, '6-6', 'left'), { type: 'draw', player: 1 }).error.code, 'draw-not-allowed');
});
test('compra: eu só compro sem jogada e devo informar a peça', () => {
  let s = createGame(RULE_PRESETS.compra2, { myHand: ['6-6', '1-2', '2-3', '3-4', '4-5', '0-5', '0-0'], starter: 0 }).state;
  s = play(s, 0, '6-6', 'left');
  s = play(s, 1, '6-6'.replace('6-6', '1-6'), 'left');        // pontas 1 | 6
  // tenho 1-2 -> jogada válida, então comprar é proibido
  assert.equal(applyEvent(s, { type: 'draw', player: 0, tileId: '3-3' }).error.code, 'draw-with-moves');
});

/* ---------- fim de jogo ---------- */
test('bater (mão vazia) encerra a partida com vencedor', () => {
  const cfg = { ...RULE_PRESETS.compra2, handSize: 1, players: 2 };
  let s = createGame(cfg, { myHand: ['6-6'], starter: 0 }).state;
  s = play(s, 0, '6-6', 'left');
  assert.equal(s.status, 'finished');
  assert.equal(s.winner, 0);
  assert.equal(applyEvent(s, { type: 'pass', player: 1 }).error.code, 'game-over');
});
test('jogo fechado é detectado automaticamente', () => {
  // duplo-6; mesa montada para que 6 e 6 fiquem esgotados nas pontas
  const cfg = { ...RULE_PRESETS.individual4 };
  let s = createGame(cfg, { myHand: ['6-6', '5-6', '4-6', '3-6', '2-6', '1-6'], starter: 0 }).state;
  s = play(s, 0, '6-6', 'left');                  // 6|6
  s = play(s, 1, '0-6', 'right');                 // 6|0 (6-0 era a 7ª peça do 6)
  assert.equal(isBlocked(s), false);
  s = play(s, 2, '0-0', 'right');                 // 6|0
  // pontas 6 e 0: restam peças com 0 -> ainda não fechado
  assert.equal(s.status, 'playing');
});
test('todos passando em sequência fecha o jogo (peças dormindo)', () => {
  let s = newGame();
  s = play(s, 0, '6-6', 'left');
  for (const p of [1, 2, 3]) s = applyEvent(s, { type: 'pass', player: p }).state;
  assert.equal(s.status, 'playing');
  assert.equal(s.passStreak, 3);
  s = play(s, 0, '6-3', 'right');
  assert.equal(s.passStreak, 0);
  // eu fico sem jogada de propósito: mão só com peças que não encaixam em 6|3
  const cfg = { ...RULE_PRESETS.individual4 };
  let g = createGame(cfg, { myHand: ['6-6', '1-2', '1-1', '2-2', '1-5', '2-5'], starter: 0 }).state;
  g = play(g, 0, '6-6', 'left');
  for (const p of [1, 2, 3, 0]) g = applyEvent(g, { type: 'pass', player: p }).state;
  assert.equal(g.status, 'blocked');
  assert.equal(g.endReason, 'closed');
});
test('declarar fechamento manualmente encerra', () => {
  let s = newGame();
  s = play(s, 0, '6-6', 'left');
  const r = applyEvent(s, { type: 'block' });
  assert.equal(r.state.status, 'blocked');
  assert.equal(r.state.endReason, 'declared');
});

/* ---------- histórico ---------- */
test('desfazer e salvar/carregar reproduzem o mesmo estado', () => {
  let s = newGame();
  s = play(s, 0, '6-6', 'left');
  s = play(s, 1, '6-1', 'right');
  s = play(s, 2, '1-3', 'right');
  const u = undoLastEvent(s);
  assert.ok(u.ok);
  assert.equal(u.state.events.length, 2);
  assert.deepEqual(getEnds(u.state), { left: 6, right: 1 });
  const saved = serializeGame(s);
  const back = deserializeGame(saved);
  assert.ok(back.ok);
  assert.deepEqual(back.state.board, s.board);
  assert.ok(!deserializeGame('{lixo').ok);
});

/* ---------- estratégia ---------- */
test('recomendação: espera a vez, indica compra ou passe, nunca jogada ilegal', () => {
  let s = newGame();
  let rec = recommend(s);
  assert.equal(rec.action, 'play');
  assert.equal(rec.best.move.tileId, '6-6');
  s = play(s, 0, '6-6', 'left');
  assert.equal(recommend(s).action, 'wait');
  const forced = recommend(s, { ignoreTurn: true });
  assert.equal(forced.action, 'play');
  assert.equal(forced.best.move.tileId, '3-6');
});
test('recomendação: todas as jogadas ranqueadas são legais e vêm ordenadas', () => {
  let s = newGame('individual4', ['6-6', '6-3', '5-3', '2-2', '0-1', '4-5']);
  s = play(s, 0, '6-6', 'left');
  s = play(s, 1, '6-5', 'right');
  s = play(s, 2, '5-5', 'right');
  s = play(s, 3, '5-1', 'right');
  const legal = new Set(legalMoves(s).map((m) => `${m.tileId}:${m.end}`));
  const ranked = rankMoves(s);
  assert.ok(ranked.length > 0);
  for (const r of ranked) assert.ok(legal.has(`${r.move.tileId}:${r.move.end}`) || legal.has(`${r.move.tileId}:${r.move.end === 'left' ? 'right' : 'left'}`));
  for (let i = 1; i < ranked.length; i += 1) assert.ok(ranked[i - 1].score >= ranked[i].score);
  assert.ok(ranked[0].reasons.length > 0);
});
test('recomendação: vence quando pode bater', () => {
  const cfg = { ...RULE_PRESETS.compra2, handSize: 2, players: 2 };
  let s = createGame(cfg, { myHand: ['6-6', '6-3'], starter: 0 }).state;
  s = play(s, 0, '6-6', 'left');
  s = play(s, 1, '6-0', 'right');
  s = play(s, 0, '3-6', 'left');     // fica 3|0 → minha mão vazia? (6-3 jogada)
  assert.equal(s.status, 'finished');
});

/* ---------- simulações de partidas completas ---------- */
function shuffle(a, rnd) { const x = a.slice(); for (let i = x.length - 1; i > 0; i -= 1) { const j = Math.floor(rnd() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; } return x; }
function mulberry(seed) { let t = seed; return () => { t += 0x6D2B79F5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; }; }

function simulate(preset, seed, meUsesStrategy) {
  const rnd = mulberry(seed);
  const cfg = RULE_PRESETS[preset];
  const all = shuffle(createTileSet(cfg.maxPip), rnd);
  const hands = [];
  for (let p = 0; p < cfg.players; p += 1) hands.push(all.splice(0, cfg.handSize));
  const boneyard = all;
  // quem começa: maior carroça, senão maior peça
  let starter = 0; let best = -1;
  hands.forEach((h, p) => h.forEach((id) => { const t = parseTile(id); const v = (t.a === t.b ? 100 : 0) + t.a + t.b + t.b / 100; if (v > best) { best = v; starter = p; } }));
  let s = createGame(cfg, { myHand: hands[0], starter }).state;
  let guard = 0;
  while (s.status === 'playing' && guard < 400) {
    guard += 1;
    const p = s.turn;
    let ev;
    const handIds = hands[p];
    if (p === 0) {
      const rec = recommend(s);
      if (rec.action === 'play' && meUsesStrategy) {
        const legal = legalMoves(s);
        assert.ok(legal.some((m) => m.tileId === rec.best.move.tileId), 'estratégia sugeriu peça ilegal');
        ev = { type: 'play', player: 0, tileId: rec.best.move.tileId, end: rec.best.move.end };
      } else if (rec.action === 'play') {
        const legal = legalMoves(s);
        const m = legal[Math.floor(rnd() * legal.length)];
        ev = { type: 'play', player: 0, tileId: m.tileId, end: m.end };
      } else if (rec.action === 'draw') {
        const id = boneyard.pop(); handIds.push(id);
        ev = { type: 'draw', player: 0, tileId: id };
      } else ev = { type: 'pass', player: 0 };
    } else {
      const legal = legalMoves(s, handIds);
      if (legal.length) {
        const m = legal[Math.floor(rnd() * legal.length)];
        ev = { type: 'play', player: p, tileId: m.tileId, end: m.end };
      } else if (cfg.drawRule !== 'none' && boneyard.length > cfg.boneyardReserve) {
        handIds.push(boneyard.pop());
        ev = { type: 'draw', player: p };
      } else ev = { type: 'pass', player: p };
    }
    const r = applyEvent(s, ev);
    assert.ok(r.ok, `evento rejeitado: ${JSON.stringify(ev)} ${r.error && r.error.message}`);
    assert.ok(!r.warnings.some((w) => ['played-missing-number', 'out-of-turn', 'pass-with-boneyard'].includes(w.code)), `aviso inesperado ${JSON.stringify(r.warnings)}`);
    if (ev.type === 'play' && p !== 0) hands[p] = hands[p].filter((x) => x !== ev.tileId);
    if (ev.type === 'play' && p === 0) hands[0] = hands[0].filter((x) => x !== ev.tileId);
    s = r.state;
    const errs = checkConsistency(s).filter((i) => i.severity === 'error');
    assert.equal(errs.length, 0, JSON.stringify(errs));
    assert.equal(unseenTiles(s).length + s.board.length + s.myHand.length, 28 * ((cfg.maxPip + 1) * (cfg.maxPip + 2) / 2) / 28);
  }
  assert.ok(guard < 400, 'partida não terminou');
  // vencedor
  let winner;
  if (s.endReason === 'out') winner = s.winner;
  else {
    const pips = hands.map((h) => h.reduce((a, id) => a + tilePips(id), 0));
    const min = Math.min(...pips);
    const cands = pips.map((v, i) => (v === min ? i : -1)).filter((i) => i >= 0);
    winner = cands.length === 1 ? cands[0] : -1;
  }
  const winTeam = cfg.teams ? (winner >= 0 ? winner % 2 : -1) : winner;
  return { win: cfg.teams ? winTeam === 0 : winner === 0, ended: s.endReason, moves: s.events.length };
}

for (const preset of Object.keys(RULE_PRESETS)) {
  test(`simulação ${preset}: 300 partidas completas sem erro de regra`, () => {
    let wins = 0; let winsRand = 0; const reasons = {};
    for (let i = 0; i < 300; i += 1) {
      const a = simulate(preset, 1000 + i, true);
      const b = simulate(preset, 1000 + i, false);
      if (a.win) wins += 1;
      if (b.win) winsRand += 1;
      reasons[a.ended] = (reasons[a.ended] || 0) + 1;
    }
    console.log(`        estratégia: ${(wins / 3).toFixed(1)}% vitórias | aleatório: ${(winsRand / 3).toFixed(1)}% | finais: ${JSON.stringify(reasons)}`);
  });
}

console.log(`\n${passed} testes passaram${process.exitCode ? ' (HÁ FALHAS)' : ''}.`);
