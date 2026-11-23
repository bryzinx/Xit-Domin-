/* ==========================================================================
 * XIT DOMINÓ — xit-domino-strategy.js
 * Motor matemático de estratégia. Sem IA generativa: apenas probabilidade
 * (hipergeométrica) e uma função de pontuação com pesos explícitos.
 *
 * Para cada jogada legal, calcula:
 *  - descarte de pontos (peças pesadas primeiro);
 *  - carroças jogadas cedo;
 *  - peças restantes que ainda encaixam nas novas pontas (evitar ficar preso);
 *  - controle de números (os que eu tenho muito x os que ainda estão escondidos);
 *  - chance de cada adversário NÃO ter peça para as novas pontas
 *    (usando os números que ele comprovadamente não tem, deduzidos dos passes);
 *  - ajuda ao parceiro (modo duplas);
 *  - fechamento do jogo, comparando meus pontos com a estimativa dos adversários.
 *
 * Nunca recomenda jogada ilegal: todas as candidatas vêm de legalMoves().
 * Não promete vitória: devolve a jogada de maior pontuação esperada.
 * ========================================================================== */

import {
  SEAT_ME,
  legalMoves,
  unseenTiles,
  boneyardAvailable,
  parseTile,
  isDouble,
  pipCount,
  fmtTile,
} from './xit-domino-engine.js';

export const WEIGHTS = Object.freeze({
  win: 1000,
  shedPip: 1.4,
  doubleEarly: 6,
  followUp: 8,
  followUpCap: 3,
  deadHand: -45,
  controlMine: 3,
  controlUnseen: -1.5,
  oppPass: 36,
  nextOppBoost: 1.5,
  partnerOpen: 8,
  blockK: 4,
  blockCap: 260,
  nearBlock: 5,
});

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* -------------------------------------------------------------------------
 * Contexto da partida (calculado uma vez por recomendação)
 * ----------------------------------------------------------------------- */
function buildContext(s) {
  const n = s.config.players;
  const unseen = unseenTiles(s).map((id) => ({ id, ...parseTile(id) }));
  const unseenByValue = new Array(s.config.maxPip + 1).fill(0);
  let pipSum = 0;
  for (const t of unseen) {
    unseenByValue[t.a] += 1;
    if (t.b !== t.a) unseenByValue[t.b] += 1;
    pipSum += t.a + t.b;
  }
  const partner = s.config.teams && n === 4 ? 2 : -1;
  const opponents = [];
  for (let i = 1; i < n; i += 1) if (i !== partner) opponents.push(i);
  const oppHandAvg = opponents.length
    ? opponents.reduce((acc, p) => acc + s.handCounts[p], 0) / opponents.length
    : 0;
  return {
    unseen,
    unseenByValue,
    avgUnseenPip: unseen.length ? pipSum / unseen.length : 0,
    partner,
    opponents,
    next: 1 % n,
    oppHandAvg,
  };
}

/**
 * Probabilidade de o jogador p NÃO ter nenhuma peça que encaixe nos valores dados.
 * O universo possível dele exclui peças com números que ele comprovadamente não tem.
 */
export function probNoMatch(s, ctx, p, values) {
  const miss = s.missing[p] || [];
  let pool = 0;
  let matching = 0;
  for (const t of ctx.unseen) {
    if (miss.includes(t.a) || miss.includes(t.b)) continue;
    pool += 1;
    if (values.includes(t.a) || values.includes(t.b)) matching += 1;
  }
  const h = Math.min(s.handCounts[p], pool);
  if (h <= 0) return 1;
  if (matching === 0) return 1;
  if (h > pool - matching) return 0;
  let pr = 1;
  for (let i = 0; i < h; i += 1) pr *= (pool - matching - i) / (pool - i);
  return pr;
}

/* -------------------------------------------------------------------------
 * Avaliação de uma jogada
 * ----------------------------------------------------------------------- */
export function evaluateMove(s, move, ctx = buildContext(s)) {
  const W = WEIGHTS;
  const handAfter = s.myHand.filter((id) => id !== move.tileId);
  const vals = move.newLeft === move.newRight ? [move.newLeft] : [move.newLeft, move.newRight];
  const breakdown = {};
  const info = { oppPass: [], partnerPass: null, playableAfter: 0, myPipsAfter: pipCount(handAfter) };

  if (handAfter.length === 0) {
    breakdown.win = W.win;
    return finalize(move, breakdown, info);
  }

  breakdown.shed = move.pips * W.shedPip;
  if (isDouble(move.tileId) && s.board.length > 0) breakdown.doubleEarly = W.doubleEarly;

  const playable = handAfter.filter((id) => {
    const t = parseTile(id);
    return vals.includes(t.a) || vals.includes(t.b);
  }).length;
  info.playableAfter = playable;
  if (playable === 0) breakdown.deadHand = W.deadHand;
  else breakdown.followUp = Math.min(playable, W.followUpCap) * W.followUp;

  const mineCount = (v) => handAfter.reduce((c, id) => {
    const t = parseTile(id);
    return c + (t.a === v || t.b === v ? 1 : 0);
  }, 0);
  breakdown.control = [move.newLeft, move.newRight].reduce(
    (acc, v) => acc + W.controlMine * mineCount(v) + W.controlUnseen * ctx.unseenByValue[v],
    0,
  );

  if (ctx.opponents.length) {
    let sum = 0;
    for (const p of ctx.opponents) {
      const pr = probNoMatch(s, ctx, p, vals);
      info.oppPass.push({ player: p, probability: pr });
      sum += pr * W.oppPass * (p === ctx.next ? W.nextOppBoost : 1);
    }
    breakdown.oppPass = sum / ctx.opponents.length;
  }

  if (ctx.partner >= 0) {
    const pp = probNoMatch(s, ctx, ctx.partner, vals);
    info.partnerPass = pp;
    breakdown.partnerOpen = (1 - pp) * W.partnerOpen;
  }

  const outsideEnds =
    ctx.unseen.filter((t) => vals.includes(t.a) || vals.includes(t.b)).length + playable;
  const expectedOpp = ctx.avgUnseenPip * ctx.oppHandAvg;
  const edge = expectedOpp - info.myPipsAfter;
  info.expectedOppPips = expectedOpp;
  if (outsideEnds === 0) {
    breakdown.block = clamp(edge * W.blockK, -W.blockCap, W.blockCap);
    info.closesGame = true;
  } else if (outsideEnds <= 3) {
    breakdown.nearBlock = (4 - outsideEnds) * W.nearBlock * Math.sign(edge);
  }

  return finalize(move, breakdown, info);
}

function finalize(move, breakdown, info) {
  const score = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { move, score, breakdown, info };
}

/* -------------------------------------------------------------------------
 * Ranking
 * ----------------------------------------------------------------------- */
export function rankMoves(s) {
  const moves = legalMoves(s);
  const ctx = buildContext(s);

  // jogadas equivalentes (mesma peça e mesmas pontas finais) aparecem uma só vez
  const seen = new Set();
  const unique = [];
  for (const m of moves) {
    const key = `${m.tileId}|${m.newLeft}|${m.newRight}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(m);
  }

  const ranked = unique.map((m) => evaluateMove(s, m, ctx));
  ranked.sort((x, y) => {
    if (y.score !== x.score) return y.score - x.score;
    if (y.move.pips !== x.move.pips) return y.move.pips - x.move.pips;
    return x.move.tileId < y.move.tileId ? -1 : 1;
  });
  ranked.forEach((r) => { r.reasons = explain(r, s); });
  return ranked;
}

/* -------------------------------------------------------------------------
 * Explicações em português (para a interface)
 * ----------------------------------------------------------------------- */
function explain(r, s) {
  const b = r.breakdown;
  const out = [];
  if (b.win) out.push('Esta jogada esvazia a sua mão: você vence a partida.');
  if (b.shed >= 8) out.push(`Descarta ${r.move.pips} pontos de uma vez, reduzindo o risco no fechamento.`);
  if (b.doubleEarly) out.push('Joga uma carroça enquanto ainda é fácil se livrar dela.');
  if (b.followUp) out.push(`Depois dela, ${r.info.playableAfter} peça(s) da sua mão ainda encaixam nas pontas.`);
  if (b.deadHand) out.push('Atenção: depois dela, nenhuma peça da sua mão encaixa nas pontas (risco de passar a vez).');
  if (b.oppPass && s.config.players > 1) {
    const best = r.info.oppPass.reduce((a, c) => (c.probability > a.probability ? c : a), { probability: 0 });
    if (best.probability >= 0.15) {
      out.push(`Chance estimada de o jogador ${best.player} ficar sem jogada: ${Math.round(best.probability * 100)}%.`);
    }
  }
  if (b.partnerOpen !== undefined && r.info.partnerPass !== null && r.info.partnerPass >= 0.5) {
    out.push('Atenção: seu parceiro provavelmente não terá peça para estas pontas.');
  }
  if (r.info.closesGame) {
    const mine = r.info.myPipsAfter;
    const exp = Math.round(r.info.expectedOppPips);
    out.push(b.block > 0
      ? `Fecha o jogo com ${mine} pontos na mão, abaixo da estimativa dos adversários (~${exp}).`
      : `Fecha o jogo com ${mine} pontos na mão, acima da estimativa dos adversários (~${exp}): arriscado.`);
  } else if (b.nearBlock) {
    out.push(b.nearBlock > 0
      ? 'Aproxima o fechamento do jogo em um momento favorável para você.'
      : 'Aproxima o fechamento do jogo em um momento desfavorável para você.');
  }
  if (!out.length) out.push('Melhor equilíbrio geral entre as jogadas legais disponíveis.');
  return out;
}

/* -------------------------------------------------------------------------
 * Instruções passo a passo
 * ----------------------------------------------------------------------- */
export function buildInstructions(move) {
  const name = fmtTile(move.tileId);
  if (move.end === 'start') {
    return {
      title: 'ABRA A PARTIDA',
      steps: [
        `Pegue a peça ${name.replace('|', '-')}.`,
        'Coloque-a no centro da mesa.',
        'Confirme a jogada.',
      ],
    };
  }
  const side = move.end === 'left' ? 'esquerda' : 'direita';
  const newEnd = move.end === 'left' ? move.newLeft : move.newRight;
  return {
    title: 'MELHOR JOGADA ENCONTRADA',
    steps: [
      `Pegue a peça ${name.replace('|', '-')}.`,
      `Posicione o número ${move.touch} na extremidade ${side} (a ponta que mostra ${move.touch}).`,
      `A ponta ${side} passará a mostrar ${newEnd}.`,
      'Confirme a jogada.',
    ],
  };
}

/* -------------------------------------------------------------------------
 * Recomendação
 * ----------------------------------------------------------------------- */
/**
 * @returns {{action:'play'|'draw'|'pass'|'wait'|'none', ...}}
 *  play  -> best, alternatives, ranked, instructions
 *  draw  -> deve comprar
 *  pass  -> deve passar
 *  wait  -> não é a minha vez (use opts.ignoreTurn para calcular mesmo assim)
 *  none  -> partida encerrada
 */
export function recommend(s, opts = {}) {
  if (s.status !== 'playing') return { action: 'none', message: 'A partida terminou.' };
  if (s.turn !== SEAT_ME && !opts.ignoreTurn) {
    return { action: 'wait', turn: s.turn, message: `Aguardando o jogador ${s.turn}.` };
  }

  const ranked = rankMoves(s);
  if (ranked.length) {
    return {
      action: 'play',
      best: ranked[0],
      alternatives: ranked.slice(1, 3),
      ranked,
      instructions: buildInstructions(ranked[0].move),
      disclaimer: 'Estimativa baseada nas peças visíveis; não garante vitória.',
    };
  }

  const rule = s.config.drawRule;
  const avail = boneyardAvailable(s);
  if (rule !== 'none' && avail > 0 && !(rule === 'single' && s.drawsThisTurn >= 1)) {
    return {
      action: 'draw',
      message: 'Você não tem jogada válida. Compre uma peça do monte e informe qual foi.',
    };
  }
  return {
    action: 'pass',
    message: 'Você não tem jogada válida. Passe a vez.',
  };
}
