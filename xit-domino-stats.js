/* ==========================================================================
 * XIT DOMINÓ — xit-domino-stats.js
 * Estatísticas da tela inicial e persistência no armazenamento local do navegador.
 *
 * - Tudo fica no localStorage do aparelho. Nada é enviado a servidores.
 * - Se o localStorage estiver indisponível (modo privado, bloqueio), usa a
 *   memória da sessão e informa isso em `persistent === false`.
 * - O armazenamento é injetável, o que permite testar fora do navegador.
 * ========================================================================== */

import { teamOf } from './xit-domino-engine.js';

export const STATS_KEY = 'xit-domino:stats:v1';
const MAX_HISTORY = 100;
const RESULTS = ['win', 'loss', 'draw', 'abandoned'];

function emptyData() {
  return {
    version: 1,
    tracked: 0,      // partidas acompanhadas (iniciadas com o assistente)
    played: 0,       // partidas concluídas (vitória, derrota ou empate)
    wins: 0,
    losses: 0,
    draws: 0,
    totalTimeMs: 0,  // tempo total de jogo (inclui partidas abandonadas)
    history: [],
  };
}

export function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

function detectStorage() {
  try {
    const ls = globalThis.localStorage;
    if (ls) {
      const probe = '__xit_domino_probe__';
      ls.setItem(probe, '1');
      ls.removeItem(probe);
      return { storage: ls, persistent: true };
    }
  } catch (e) {
    /* cai para a memória */
  }
  return { storage: createMemoryStorage(), persistent: false };
}

const num = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

function sanitize(raw) {
  const base = emptyData();
  if (!raw || typeof raw !== 'object' || raw.version !== 1) return base;
  base.tracked = num(raw.tracked);
  base.played = num(raw.played);
  base.wins = num(raw.wins);
  base.losses = num(raw.losses);
  base.draws = num(raw.draws);
  base.totalTimeMs = num(raw.totalTimeMs);
  if (Array.isArray(raw.history)) {
    base.history = raw.history
      .filter((h) => h && RESULTS.includes(h.result))
      .slice(-MAX_HISTORY)
      .map((h) => ({
        endedAt: num(h.endedAt),
        durationMs: num(h.durationMs),
        moves: num(h.moves),
        result: h.result,
        modality: typeof h.modality === 'string' ? h.modality.slice(0, 60) : '',
      }));
  }
  // coerência: partidas concluídas = vitórias + derrotas + empates
  base.played = base.wins + base.losses + base.draws;
  return base;
}

export function formatDuration(ms) {
  const total = Math.floor(num(ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}min`;
  if (m > 0) return `${m}min ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/**
 * Resultado da partida do ponto de vista do usuário.
 * - Alguém bateu: vitória se for o usuário (ou a dupla dele).
 * - Jogo fechado: os pontos dos outros não são visíveis, então o usuário
 *   informa o desfecho em blockOutcome ('win' | 'loss' | 'draw').
 * @returns {'win'|'loss'|'draw'|null} null = ainda não dá para saber
 */
export function resultFromGame(state, blockOutcome) {
  if (state.status === 'finished') {
    return teamOf(state.winner, state.config) === teamOf(0, state.config) ? 'win' : 'loss';
  }
  if (state.status === 'blocked') {
    return ['win', 'loss', 'draw'].includes(blockOutcome) ? blockOutcome : null;
  }
  return null;
}

export function createStatsStore(storageOverride, key = STATS_KEY) {
  let storage;
  let persistent;
  if (storageOverride) {
    storage = storageOverride;
    persistent = true;
  } else {
    ({ storage, persistent } = detectStorage());
  }
  let lastError = null;

  function load() {
    try {
      const text = storage.getItem(key);
      return text ? sanitize(JSON.parse(text)) : emptyData();
    } catch (e) {
      lastError = 'Não foi possível ler as estatísticas salvas.';
      return emptyData();
    }
  }

  let data = load();

  function save() {
    try {
      storage.setItem(key, JSON.stringify(data));
      return true;
    } catch (e) {
      lastError = 'Não foi possível salvar as estatísticas neste aparelho.';
      persistent = false;
      return false;
    }
  }

  function summary() {
    const winRate = data.played > 0 ? Math.round((data.wins / data.played) * 1000) / 10 : 0;
    return {
      tracked: data.tracked,
      played: data.played,
      wins: data.wins,
      losses: data.losses,
      draws: data.draws,
      winRate,
      totalTimeMs: data.totalTimeMs,
      totalTimeText: formatDuration(data.totalTimeMs),
      history: data.history.slice(),
      persistent,
      lastError,
    };
  }

  return {
    getSummary: summary,

    /** Chamar quando uma partida é iniciada com o assistente. */
    recordTracked() {
      data.tracked += 1;
      save();
      return summary();
    },

    /**
     * @param {{result:'win'|'loss'|'draw'|'abandoned', durationMs:number, moves?:number, modality?:string}} game
     */
    recordGame(game) {
      if (!game || !RESULTS.includes(game.result)) {
        throw new Error('Resultado inválido: use win, loss, draw ou abandoned.');
      }
      const durationMs = num(game.durationMs);
      if (game.result === 'win') data.wins += 1;
      else if (game.result === 'loss') data.losses += 1;
      else if (game.result === 'draw') data.draws += 1;
      data.played = data.wins + data.losses + data.draws;
      data.totalTimeMs += durationMs;
      data.history.push({
        endedAt: Date.now(),
        durationMs,
        moves: num(game.moves),
        result: game.result,
        modality: typeof game.modality === 'string' ? game.modality.slice(0, 60) : '',
      });
      if (data.history.length > MAX_HISTORY) data.history = data.history.slice(-MAX_HISTORY);
      save();
      return summary();
    },

    reset() {
      data = emptyData();
      try { storage.removeItem(key); } catch (e) { /* ignora */ }
      return summary();
    },

    exportJSON() {
      return JSON.stringify(data);
    },

    importJSON(text) {
      let parsed;
      try { parsed = JSON.parse(text); } catch (e) { return { ok: false, message: 'Arquivo inválido.' }; }
      if (!parsed || parsed.version !== 1) return { ok: false, message: 'Formato de estatísticas não reconhecido.' };
      data = sanitize(parsed);
      save();
      return { ok: true, summary: summary() };
    },
  };
}
