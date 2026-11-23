/* ==========================================================================
 * XIT DOMINÓ — xit-domino-engine.js
 * Motor de regras do dominó. Sem DOM, sem câmera, sem IA generativa.
 *
 * Responsabilidades:
 *  - Conjuntos de peças (duplo-6, duplo-9, duplo-12) e identificação de peças.
 *  - Configuração e regras predefinidas.
 *  - Estado da partida e eventos (jogar, passar, comprar, fechar).
 *  - Cadeia da mesa, pontas abertas, jogadas legais.
 *  - Rastreio de números que cada adversário NÃO possui (deduzido de passes).
 *  - Verificação de consistência (duplicações, cadeia inválida, contagens).
 *  - Desfazer/refazer por reprodução (replay) do histórico de eventos.
 *
 * O estado é um objeto JSON puro (serializável no localStorage).
 * Jogador 0 = EU (o usuário). Os demais seguem a ordem da mesa (sentido do jogo).
 * Orientação da cadeia: "esquerda" e "direita" são as do usuário, olhando a mesa.
 * ========================================================================== */

export const SEAT_ME = 0;

/* -------------------------------------------------------------------------
 * Regras predefinidas
 * ----------------------------------------------------------------------- */
export const RULE_PRESETS = Object.freeze({
  brasileiro: Object.freeze({
    id: 'brasileiro',
    name: 'Brasileiro — duplas (4 jogadores)',
    maxPip: 6, players: 4, handSize: 6,
    drawRule: 'none', teams: true,
    firstMove: 'highest-double', boneyardReserve: 0,
  }),
  individual4: Object.freeze({
    id: 'individual4',
    name: 'Individual — 4 jogadores, sem compra',
    maxPip: 6, players: 4, handSize: 6,
    drawRule: 'none', teams: false,
    firstMove: 'highest-double', boneyardReserve: 0,
  }),
  compra2: Object.freeze({
    id: 'compra2',
    name: 'Com compra — 2 jogadores',
    maxPip: 6, players: 2, handSize: 7,
    drawRule: 'until-playable', teams: false,
    firstMove: 'highest-double', boneyardReserve: 0,
  }),
  compra3: Object.freeze({
    id: 'compra3',
    name: 'Com compra — 3 jogadores',
    maxPip: 6, players: 3, handSize: 7,
    drawRule: 'until-playable', teams: false,
    firstMove: 'highest-double', boneyardReserve: 0,
  }),
  duplo9: Object.freeze({
    id: 'duplo9',
    name: 'Duplo-9 — 4 jogadores, com compra',
    maxPip: 9, players: 4, handSize: 10,
    drawRule: 'until-playable', teams: false,
    firstMove: 'highest-double', boneyardReserve: 0,
  }),
});

const DEFAULT_CONFIG = Object.freeze({
  id: 'custom',
  name: 'Personalizada',
  maxPip: 6,
  players: 4,
  handSize: 6,
  drawRule: 'none',        // 'none' | 'single' | 'until-playable'
  teams: false,            // apenas com 4 jogadores (eu + parceiro na posição 2)
  firstMove: 'highest-double', // 'highest-double' | 'any'
  boneyardReserve: 0,      // peças que não podem ser compradas (ex.: 2)
});

const DRAW_RULES = ['none', 'single', 'until-playable'];
const FIRST_MOVES = ['highest-double', 'any'];

/* -------------------------------------------------------------------------
 * Utilidades de peças
 * ----------------------------------------------------------------------- */
export function tileId(a, b) {
  const x = Math.min(a, b);
  const y = Math.max(a, b);
  return `${x}-${y}`;
}

export function parseTile(id) {
  if (typeof id !== 'string') return null;
  const m = /^(\d+)-(\d+)$/.exec(id);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a > b) return null;
  return { a, b };
}

/** Aceita "6-3", "6|3", "6/3", [6,3], {a,b} ou {left,right}. Retorna id normalizado ou null. */
export function toTileId(x, maxPip = 12) {
  let a;
  let b;
  if (typeof x === 'string') {
    const m = /^\s*(\d+)\s*[-|/]\s*(\d+)\s*$/.exec(x);
    if (!m) return null;
    a = Number(m[1]);
    b = Number(m[2]);
  } else if (Array.isArray(x) && x.length === 2) {
    a = Number(x[0]);
    b = Number(x[1]);
  } else if (x && typeof x === 'object') {
    a = Number(x.a !== undefined ? x.a : x.left);
    b = Number(x.b !== undefined ? x.b : x.right);
  } else {
    return null;
  }
  if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
  if (a < 0 || b < 0 || a > maxPip || b > maxPip) return null;
  return tileId(a, b);
}

export function isDouble(id) {
  const t = parseTile(id);
  return !!t && t.a === t.b;
}

export function tilePips(id) {
  const t = parseTile(id);
  return t ? t.a + t.b : 0;
}

export function pipCount(ids) {
  return ids.reduce((sum, id) => sum + tilePips(id), 0);
}

export function fmtTile(id) {
  const t = parseTile(id);
  return t ? `${t.a}|${t.b}` : String(id);
}

export function totalTiles(maxPip) {
  return ((maxPip + 1) * (maxPip + 2)) / 2;
}

export function createTileSet(maxPip) {
  const ids = [];
  for (let a = 0; a <= maxPip; a += 1) {
    for (let b = a; b <= maxPip; b += 1) ids.push(tileId(a, b));
  }
  return ids;
}

const clone = (o) => JSON.parse(JSON.stringify(o));
const fail = (code, message) => ({ ok: false, error: { code, message } });

/* -------------------------------------------------------------------------
 * Configuração
 * ----------------------------------------------------------------------- */
export function normalizeConfig(input = {}) {
  const c = { ...DEFAULT_CONFIG, ...input };
  const errors = [];

  c.maxPip = Number(c.maxPip);
  c.players = Number(c.players);
  c.handSize = Number(c.handSize);
  c.boneyardReserve = Number(c.boneyardReserve || 0);
  c.teams = Boolean(c.teams);

  if (![6, 9, 12].includes(c.maxPip)) errors.push('O conjunto deve ser duplo-6, duplo-9 ou duplo-12.');
  if (!Number.isInteger(c.players) || c.players < 2 || c.players > 4) errors.push('O número de jogadores deve ser de 2 a 4.');
  if (!Number.isInteger(c.handSize) || c.handSize < 1) errors.push('Cada jogador precisa receber ao menos 1 peça.');
  if (!DRAW_RULES.includes(c.drawRule)) errors.push('Regra de compra inválida.');
  if (!FIRST_MOVES.includes(c.firstMove)) errors.push('Regra de abertura inválida.');
  if (c.teams && c.players !== 4) errors.push('O modo em duplas exige exatamente 4 jogadores.');

  if (errors.length === 0) {
    const total = totalTiles(c.maxPip);
    const dealt = c.players * c.handSize;
    if (dealt > total) errors.push(`São necessárias ${dealt} peças, mas o conjunto só tem ${total}.`);
    const boneyard = total - dealt;
    if (c.drawRule !== 'none' && boneyard <= 0) errors.push('A compra exige peças sobrando no monte.');
    if (!Number.isInteger(c.boneyardReserve) || c.boneyardReserve < 0 || c.boneyardReserve > boneyard) {
      errors.push('Reserva do monte inválida.');
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, config: c };
}

export function teamOf(player, config) {
  return config.teams ? player % 2 : player;
}

/* -------------------------------------------------------------------------
 * Criação do jogo
 * ----------------------------------------------------------------------- */
/**
 * @param {object} configInput  configuração (parcial) — será normalizada
 * @param {{myHand: Array, starter?: number}} setup  minhas peças e quem começa
 */
export function createGame(configInput, setup = {}) {
  const norm = normalizeConfig(configInput);
  if (!norm.ok) return fail('bad-config', norm.errors[0]);
  const config = norm.config;

  const rawHand = Array.isArray(setup.myHand) ? setup.myHand : [];
  const myHand = [];
  for (const raw of rawHand) {
    const id = toTileId(raw, config.maxPip);
    if (!id) return fail('bad-tile', 'Há uma peça inválida na sua mão.');
    if (myHand.includes(id)) return fail('duplicate-hand', `A peça ${fmtTile(id)} aparece duas vezes na sua mão.`);
    myHand.push(id);
  }
  if (myHand.length !== config.handSize) {
    return fail('hand-size', `Sua mão deve ter ${config.handSize} peças (foram informadas ${myHand.length}).`);
  }

  const starter = Number.isInteger(setup.starter) ? setup.starter : 0;
  if (starter < 0 || starter >= config.players) return fail('bad-starter', 'Jogador inicial inválido.');

  const handCounts = new Array(config.players).fill(config.handSize);
  const missing = Array.from({ length: config.players }, () => []);

  const state = {
    version: 1,
    config,
    initial: { myHand: myHand.slice().sort(), starter },
    events: [],
    myHand: myHand.slice().sort(),
    board: [],              // [{id, left, right}] orientados da esquerda para a direita
    handCounts,             // handCounts[0] = minhas peças
    missing,                // missing[p] = números que o jogador p comprovadamente não tem
    turn: starter,
    drawsThisTurn: 0,
    passStreak: 0,          // passes consecutivos (n passes seguidos = jogo fechado)
    status: 'playing',      // 'playing' | 'finished' | 'blocked'
    winner: null,
    endReason: null,        // 'out' | 'closed' | 'declared'
  };
  return { ok: true, state };
}

/* -------------------------------------------------------------------------
 * Consultas sobre o estado
 * ----------------------------------------------------------------------- */
export function getEnds(state) {
  const b = state.board;
  if (!b.length) return null;
  return { left: b[0].left, right: b[b.length - 1].right };
}

export function boardIds(state) {
  return state.board.map((t) => t.id);
}

/** Peças que não estão na mesa nem na minha mão (mãos dos outros + monte). */
export function unseenTiles(state) {
  const used = new Set(boardIds(state));
  for (const id of state.myHand) used.add(id);
  return createTileSet(state.config.maxPip).filter((id) => !used.has(id));
}

/** Peças fora da minha mão e da mesa que ainda estão em mãos alheias ou no monte/dorme. */
export function boneyardSize(state) {
  const total = totalTiles(state.config.maxPip);
  const inHands = state.handCounts.reduce((a, b) => a + b, 0);
  return Math.max(0, total - state.board.length - inHands);
}

/** Peças que podem realmente ser compradas agora. */
export function boneyardAvailable(state) {
  return Math.max(0, boneyardSize(state) - state.config.boneyardReserve);
}

export function isBlocked(state) {
  const ends = getEnds(state);
  if (!ends) return false;
  const onBoard = new Set(boardIds(state));
  for (const id of createTileSet(state.config.maxPip)) {
    if (onBoard.has(id)) continue;
    const { a, b } = parseTile(id);
    if (a === ends.left || b === ends.left || a === ends.right || b === ends.right) return false;
  }
  return true;
}

function makeMove(id, end, placed, newLeft, newRight, touch) {
  return { tileId: id, end, placed, newLeft, newRight, touch, pips: tilePips(id) };
}

/**
 * Jogadas legais para uma mão (padrão: a minha).
 * placed = orientação da peça na cadeia (esquerda→direita).
 * touch  = número da peça que encosta na ponta da mesa.
 */
export function legalMoves(state, hand = state.myHand) {
  const moves = [];

  if (state.board.length === 0) {
    let ids = hand.slice();
    if (state.config.firstMove === 'highest-double' && ids.length) {
      const doubles = ids.filter(isDouble);
      if (doubles.length) {
        ids = [doubles.reduce((best, id) => (parseTile(id).a > parseTile(best).a ? id : best))];
      } else {
        ids = [ids.reduce((best, id) => {
          const pb = tilePips(best);
          const pi = tilePips(id);
          if (pi > pb) return id;
          if (pi === pb && parseTile(id).b > parseTile(best).b) return id;
          return best;
        })];
      }
    }
    for (const id of ids) {
      const { a, b } = parseTile(id);
      moves.push(makeMove(id, 'start', { left: a, right: b }, a, b, null));
    }
    return moves;
  }

  const { left, right } = getEnds(state);
  for (const id of hand) {
    const { a, b } = parseTile(id);

    // ponta esquerda: o lado direito da peça encosta
    if (b === left) moves.push(makeMove(id, 'left', { left: a, right: b }, a, right, b));
    else if (a === left) moves.push(makeMove(id, 'left', { left: b, right: a }, b, right, a));

    // ponta direita: o lado esquerdo da peça encosta
    if (a === right) moves.push(makeMove(id, 'right', { left: a, right: b }, left, b, a));
    else if (b === right) moves.push(makeMove(id, 'right', { left: b, right: a }, left, a, b));
  }
  return moves;
}

/* -------------------------------------------------------------------------
 * Aplicação de eventos
 * Eventos:
 *   { type:'play',  player, tileId, end }      end: 'left' | 'right' (ignorado na abertura)
 *   { type:'pass',  player }
 *   { type:'draw',  player, tileId? }          tileId obrigatório quando player === 0
 *   { type:'block' }                           declara fechamento manualmente
 * Retorno: { ok:true, state, warnings } ou { ok:false, error:{code,message} }
 * Nunca altera o estado recebido.
 * ----------------------------------------------------------------------- */
export function applyEvent(state, event) {
  if (!event || typeof event !== 'object') return fail('bad-event', 'Evento inválido.');
  if (state.status !== 'playing') return fail('game-over', 'A partida já foi encerrada.');

  const s = clone(state);
  const warnings = [];
  let err = null;

  switch (event.type) {
    case 'play': err = doPlay(s, event, warnings); break;
    case 'pass': err = doPass(s, event, warnings); break;
    case 'draw': err = doDraw(s, event, warnings); break;
    case 'block':
      s.status = 'blocked';
      s.endReason = 'declared';
      break;
    default: err = fail('bad-event', 'Tipo de evento desconhecido.');
  }
  if (err) return err;

  s.events.push({ ...event });
  if (s.status === 'playing' && s.board.length > 0 && isBlocked(s)) {
    s.status = 'blocked';
    s.endReason = 'closed';
  }
  return { ok: true, state: s, warnings };
}

function checkPlayer(s, p) {
  if (!Number.isInteger(p) || p < 0 || p >= s.config.players) {
    return fail('bad-player', 'Jogador inválido.');
  }
  return null;
}

function advanceTurn(s, player, warnings) {
  if (player !== s.turn) {
    warnings.push({
      code: 'out-of-turn',
      message: `O jogador ${player} agiu fora da vez (era a vez do jogador ${s.turn}).`,
      player,
    });
  }
  s.turn = (player + 1) % s.config.players;
  s.drawsThisTurn = 0;
}

function doPlay(s, ev, warnings) {
  const bad = checkPlayer(s, ev.player);
  if (bad) return bad;
  const p = ev.player;
  const id = toTileId(ev.tileId, s.config.maxPip);
  if (!id) return fail('bad-tile', 'Peça inválida.');
  if (s.board.some((t) => t.id === id)) {
    return fail('duplicate-board', `A peça ${fmtTile(id)} já está na mesa.`);
  }
  if (p === SEAT_ME) {
    if (!s.myHand.includes(id)) return fail('not-in-hand', `A peça ${fmtTile(id)} não está na sua mão.`);
  } else if (s.myHand.includes(id)) {
    return fail('conflict-my-hand', `A peça ${fmtTile(id)} está na sua mão; outro jogador não pode jogá-la.`);
  }
  if (s.handCounts[p] <= 0) return fail('no-tiles-left', `O jogador ${p} não tem mais peças.`);

  const { a, b } = parseTile(id);
  let placed;
  let end = ev.end;

  if (s.board.length === 0) {
    placed = { left: a, right: b };
    end = 'start';
    if (p === SEAT_ME && !legalMoves(s).some((m) => m.tileId === id)) {
      warnings.push({
        code: 'first-move-rule',
        message: `A regra de abertura recomendava outra peça no lugar de ${fmtTile(id)}.`,
        player: p,
      });
    }
  } else {
    if (end !== 'left' && end !== 'right') return fail('bad-end', 'Informe a ponta (esquerda ou direita).');
    const ends = getEnds(s);
    if (end === 'left') {
      if (b === ends.left) placed = { left: a, right: b };
      else if (a === ends.left) placed = { left: b, right: a };
    } else if (a === ends.right) placed = { left: a, right: b };
    else if (b === ends.right) placed = { left: b, right: a };
    if (!placed) {
      const v = end === 'left' ? ends.left : ends.right;
      return fail('no-match', `A peça ${fmtTile(id)} não encaixa na ponta ${end === 'left' ? 'esquerda' : 'direita'} (${v}).`);
    }
    if (p !== SEAT_ME) {
      const miss = s.missing[p];
      for (const v of new Set([a, b])) {
        if (miss.includes(v)) {
          warnings.push({
            code: 'played-missing-number',
            message: `O jogador ${p} havia passado sem o número ${v}, mas jogou ${fmtTile(id)}.`,
            player: p,
            tileId: id,
            value: v,
          });
        }
      }
    }
  }

  const entry = { id, left: placed.left, right: placed.right };
  if (end === 'left') s.board.unshift(entry);
  else s.board.push(entry);
  s.passStreak = 0;

  if (p === SEAT_ME) {
    s.myHand = s.myHand.filter((x) => x !== id);
    s.handCounts[0] = s.myHand.length;
  } else {
    s.handCounts[p] -= 1;
  }

  advanceTurn(s, p, warnings);

  if (s.handCounts[p] === 0) {
    s.status = 'finished';
    s.winner = p;
    s.endReason = 'out';
  }
  return null;
}

function doPass(s, ev, warnings) {
  const bad = checkPlayer(s, ev.player);
  if (bad) return bad;
  const p = ev.player;
  if (s.board.length === 0) return fail('pass-empty-board', 'Não é possível passar antes da primeira peça.');

  const rule = s.config.drawRule;
  const avail = boneyardAvailable(s);

  if (p === SEAT_ME) {
    if (legalMoves(s).length > 0) return fail('illegal-pass', 'Você tem jogada válida; não pode passar.');
    if (rule === 'until-playable' && avail > 0) return fail('must-draw', 'Você precisa comprar peças antes de passar.');
    if (rule === 'single' && avail > 0 && s.drawsThisTurn === 0) return fail('must-draw', 'Você precisa comprar uma peça antes de passar.');
  } else if (rule !== 'none' && avail > 0 && (rule === 'until-playable' || s.drawsThisTurn === 0)) {
    warnings.push({
      code: 'pass-with-boneyard',
      message: `O jogador ${p} passou, mas ainda havia peças para comprar.`,
      player: p,
    });
  }

  const ends = getEnds(s);
  for (const v of new Set([ends.left, ends.right])) {
    if (!s.missing[p].includes(v)) s.missing[p].push(v);
  }
  s.missing[p].sort((x, y) => x - y);

  advanceTurn(s, p, warnings);
  s.passStreak += 1;
  if (s.passStreak >= s.config.players) {
    // todos passaram em sequência: ninguém consegue jogar (inclui peças que "dormem")
    s.status = 'blocked';
    s.endReason = 'closed';
  }
  return null;
}

function doDraw(s, ev, warnings) {
  const bad = checkPlayer(s, ev.player);
  if (bad) return bad;
  const p = ev.player;
  const rule = s.config.drawRule;
  if (rule === 'none') return fail('draw-not-allowed', 'Esta partida não permite compra de peças.');
  if (boneyardAvailable(s) <= 0) return fail('empty-boneyard', 'Não há peças disponíveis para comprar.');
  if (rule === 'single' && s.drawsThisTurn >= 1) {
    if (p === SEAT_ME) return fail('single-draw-limit', 'Nesta regra só é possível comprar uma peça por vez.');
    warnings.push({ code: 'single-draw-limit', message: `O jogador ${p} comprou mais de uma peça na mesma vez.`, player: p });
  }

  if (p === SEAT_ME) {
    if (s.board.length > 0 && legalMoves(s).length > 0) {
      return fail('draw-with-moves', 'Você tem jogada válida; não deve comprar.');
    }
    const id = toTileId(ev.tileId, s.config.maxPip);
    if (!id) return fail('bad-tile', 'Informe a peça comprada.');
    if (s.myHand.includes(id)) return fail('duplicate-hand', `Você já tem a peça ${fmtTile(id)}.`);
    if (s.board.some((t) => t.id === id)) return fail('duplicate-board', `A peça ${fmtTile(id)} já está na mesa.`);
    s.myHand.push(id);
    s.myHand.sort();
    s.handCounts[0] = s.myHand.length;
  } else {
    s.handCounts[p] += 1;
    // a peça comprada é desconhecida: o que se sabia sobre os números dele deixa de valer
    s.missing[p] = [];
  }
  if (p !== s.turn) {
    warnings.push({ code: 'out-of-turn', message: `O jogador ${p} comprou fora da vez.`, player: p });
  }
  s.drawsThisTurn += 1;
  s.passStreak = 0;
  return null;
}

/* -------------------------------------------------------------------------
 * Histórico: reprodução, desfazer, serialização
 * ----------------------------------------------------------------------- */
export function replay(configInput, initial, events) {
  const created = createGame(configInput, initial);
  if (!created.ok) return created;
  let state = created.state;
  const warnings = [];
  for (let i = 0; i < events.length; i += 1) {
    const r = applyEvent(state, events[i]);
    if (!r.ok) return { ok: false, error: r.error, index: i, state };
    state = r.state;
    warnings.push(...r.warnings.map((w) => ({ ...w, eventIndex: i })));
  }
  return { ok: true, state, warnings };
}

export function undoLastEvent(state) {
  if (!state.events.length) return fail('nothing-to-undo', 'Não há jogadas para desfazer.');
  return replay(state.config, state.initial, state.events.slice(0, -1));
}

export function serializeGame(state) {
  return JSON.stringify(state);
}

export function deserializeGame(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return fail('bad-json', 'Dados salvos corrompidos.');
  }
  if (!data || data.version !== 1 || !data.config || !data.initial || !Array.isArray(data.events)) {
    return fail('bad-save', 'Formato de partida salva não reconhecido.');
  }
  return replay(data.config, data.initial, data.events);
}

/* -------------------------------------------------------------------------
 * Consistência
 * ----------------------------------------------------------------------- */
export function checkConsistency(state) {
  const issues = [];
  const max = state.config.maxPip;
  const seen = new Map();

  for (const t of state.board) {
    if (seen.has(t.id)) issues.push({ severity: 'error', code: 'duplicate-board', message: `Peça ${fmtTile(t.id)} repetida na mesa.`, tileIds: [t.id] });
    seen.set(t.id, 'mesa');
    const p = parseTile(t.id);
    if (!p || p.b > max) issues.push({ severity: 'error', code: 'bad-tile', message: `Peça ${t.id} fora do conjunto.`, tileIds: [t.id] });
  }
  for (const id of state.myHand) {
    if (seen.has(id)) issues.push({ severity: 'error', code: 'hand-board-overlap', message: `Peça ${fmtTile(id)} está na mão e na mesa.`, tileIds: [id] });
    seen.set(id, 'mão');
  }
  for (let i = 0; i < state.board.length - 1; i += 1) {
    if (state.board[i].right !== state.board[i + 1].left) {
      issues.push({ severity: 'error', code: 'broken-chain', message: `A cadeia da mesa não encaixa entre ${fmtTile(state.board[i].id)} e ${fmtTile(state.board[i + 1].id)}.`, tileIds: [state.board[i].id, state.board[i + 1].id] });
    }
  }
  if (state.handCounts[0] !== state.myHand.length) {
    issues.push({ severity: 'error', code: 'hand-count', message: 'Contagem da sua mão não confere.' });
  }
  const total = totalTiles(max);
  const inHands = state.handCounts.reduce((a, b) => a + b, 0);
  if (state.board.length + inHands > total) {
    issues.push({ severity: 'error', code: 'too-many-tiles', message: 'Há mais peças em jogo do que existem no conjunto.' });
  }
  if (state.handCounts.some((c) => c < 0)) {
    issues.push({ severity: 'error', code: 'negative-count', message: 'Contagem de peças negativa.' });
  }

  // números que um jogador "não tem" mas que já saíram todos: apenas informativo
  const unseen = unseenTiles(state);
  state.missing.forEach((list, p) => {
    if (p === SEAT_ME || list.length === 0) return;
    const possible = unseen.filter((id) => {
      const t = parseTile(id);
      return !list.includes(t.a) && !list.includes(t.b);
    }).length;
    if (possible < state.handCounts[p]) {
      issues.push({ severity: 'warning', code: 'impossible-hand', message: `O jogador ${p} não teria peças possíveis suficientes: reveja os passes registrados.`, player: p });
    }
  });
  return issues;
}
