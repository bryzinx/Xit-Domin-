/* ==========================================================================
 * XIT DOMINÓ — xit-domino-cheat-detector.js
 * Monitor de irregularidades. Lógica pura, sem DOM e sem câmera.
 *
 * Princípio: uma jogada estranha NÃO é prova de trapaça. A câmera pode errar.
 * Por isso cada achado tem um nível:
 *   - 'confirmed': a irregularidade foi verificada (o usuário confirmou o
 *                  reconhecimento das peças envolvidas, ou revisou o alerta).
 *                  Rótulo vermelho: TRAPAÇA DETECTADA.
 *   - 'suspect':   a regra parece violada, mas depende de reconhecimento não
 *                  confirmado. Rótulo: IRREGULARIDADE SUSPEITA — REVISAR.
 *
 * Para evitar falsos alertas por ruído de imagem, achados baseados em
 * observações da câmera só são emitidos depois de `stableFrames` quadros
 * consecutivos mostrando o mesmo problema.
 *
 * Capturas de imagem ficam somente na memória desta sessão e só são aceitas
 * quando o usuário autorizou (setSnapshotAllowed). Nada é enviado a servidores.
 * ========================================================================== */

import { applyEvent, fmtTile } from './xit-domino-engine.js';

export const LEVEL = Object.freeze({ CONFIRMED: 'confirmed', SUSPECT: 'suspect' });

export function alertLabel(finding) {
  return finding.level === LEVEL.CONFIRMED
    ? 'TRAPAÇA DETECTADA'
    : 'IRREGULARIDADE SUSPEITA — REVISAR';
}

const ENGINE_ERRORS = {
  'no-match': { kind: 'no-match', severity: 'high' },
  'duplicate-board': { kind: 'duplicate-tile', severity: 'high' },
  'conflict-my-hand': { kind: 'tile-conflict', severity: 'high' },
  'not-in-hand': { kind: 'tile-not-in-hand', severity: 'medium' },
};

const ENGINE_WARNINGS = {
  'played-missing-number': { kind: 'missing-number', severity: 'high' },
  'pass-with-boneyard': { kind: 'pass-with-boneyard', severity: 'medium' },
  'single-draw-limit': { kind: 'draw-limit', severity: 'medium' },
  'out-of-turn': { kind: 'out-of-turn', severity: 'low', alwaysSuspect: true },
};

export function createCheatDetector(options = {}) {
  const cfg = { stableFrames: 6, minConfidence: 0.85, ...options };
  const findings = [];
  const reported = new Set();
  const pending = new Map();
  let seq = 0;
  let snapshotAllowed = false;

  function register(partial) {
    if (reported.has(partial.key)) return null;
    reported.add(partial.key);
    const finding = {
      id: `irr-${(seq += 1)}`,
      time: Date.now(),
      status: 'open',          // 'open' | 'dismissed' | 'reviewed'
      snapshot: null,
      region: null,            // {x,y,w,h} normalizados 0..1 sobre o vídeo
      player: null,
      tileId: null,
      ...partial,
    };
    findings.push(finding);
    return finding;
  }

  const levelFor = (info, forceSuspect) => (!forceSuspect && info && info.verified === true
    ? LEVEL.CONFIRMED
    : LEVEL.SUSPECT);

  /**
   * Valida uma jogada registrada contra o estado e a registra como achado se violar regras.
   * info: { verified?: boolean, region?: {x,y,w,h} }
   * Não altera o estado recebido. Se a jogada for válida, devolve o novo estado.
   */
  function checkEvent(state, event, info = {}) {
    const result = applyEvent(state, event);
    const out = [];
    const index = state.events.length;

    if (!result.ok) {
      const spec = ENGINE_ERRORS[result.error.code];
      if (spec) {
        const f = register({
          key: `ev:${index}:${result.error.code}:${event.tileId}`,
          kind: spec.kind,
          severity: spec.severity,
          level: levelFor(info),
          message: result.error.message,
          player: event.player,
          tileId: event.tileId || null,
          region: info.region || null,
        });
        if (f) out.push(f);
      }
      return { ok: false, error: result.error, findings: out };
    }

    for (const w of result.warnings) {
      const spec = ENGINE_WARNINGS[w.code];
      if (!spec) continue;
      const f = register({
        key: `ev:${index}:${w.code}:${w.player}`,
        kind: spec.kind,
        severity: spec.severity,
        level: levelFor(info, spec.alwaysSuspect),
        message: w.message,
        player: w.player,
        tileId: w.tileId || event.tileId || null,
        region: info.region || null,
      });
      if (f) out.push(f);
    }
    return { ok: true, state: result.state, warnings: result.warnings, findings: out };
  }

  /**
   * Compara a mesa observada pela câmera com a mesa registrada.
   * observed: [{ id, confidence, verified?, moved?, region? }] na ordem esquerda→direita.
   * Retorna apenas achados NOVOS desta chamada.
   */
  function observeBoard(state, observed) {
    const recorded = state.board.map((t) => t.id);
    const candidates = new Map();
    const reliable = (o) => o && o.id && o.confidence >= cfg.minConfidence;

    const upto = Math.min(recorded.length, observed.length);
    for (let i = 0; i < upto; i += 1) {
      const o = observed[i];
      if (reliable(o) && o.id !== recorded[i]) {
        const substitution = o.moved === true;
        candidates.set(`chg:${i}:${recorded[i]}>${o.id}`, {
          kind: substitution ? 'tile-substitution' : 'tile-changed',
          severity: 'high',
          level: levelFor(o),
          message: `A peça na posição ${i + 1} da mesa estava registrada como ${fmtTile(recorded[i])} e agora aparece como ${fmtTile(o.id)}${substitution ? ', com movimentação após ser colocada' : ''}.`,
          tileId: recorded[i],
          region: o.region || null,
        });
      }
    }

    const confident = observed.length > 0 && observed.every(reliable);
    if (confident && observed.length < recorded.length) {
      candidates.set(`miss:${recorded.length}:${observed.length}`, {
        kind: 'tile-missing',
        severity: 'medium',
        level: LEVEL.SUSPECT,
        message: `A câmera vê ${observed.length} peça(s) na mesa, mas o histórico registra ${recorded.length}.`,
      });
    }

    const counts = new Map();
    for (const o of observed) {
      if (reliable(o)) counts.set(o.id, (counts.get(o.id) || 0) + 1);
    }
    for (const [id, n] of counts) {
      if (n > 1) {
        candidates.set(`dup:${id}`, {
          kind: 'duplicate-observed',
          severity: 'medium',
          level: LEVEL.SUSPECT,
          message: `A peça ${fmtTile(id)} aparece ${n} vezes na mesa observada (pode ser erro de reconhecimento).`,
          tileId: id,
        });
      }
    }

    // estabilidade: o problema precisa persistir por vários quadros seguidos
    for (const key of Array.from(pending.keys())) {
      if (!candidates.has(key)) pending.delete(key);
    }
    const created = [];
    for (const [key, spec] of candidates) {
      const n = (pending.get(key) || 0) + 1;
      pending.set(key, n);
      if (n >= cfg.stableFrames) {
        const f = register({ key: `obs:${key}`, ...spec });
        if (f) created.push(f);
      }
    }
    return created;
  }

  return {
    checkEvent,
    observeBoard,

    list() { return findings.slice(); },
    open() { return findings.filter((f) => f.status === 'open'); },
    get(id) { return findings.find((f) => f.id === id) || null; },

    /** Botão X do alerta: ignora e fecha. */
    dismiss(id) {
      const f = findings.find((x) => x.id === id);
      if (!f) return false;
      f.status = 'dismissed';
      return true;
    },

    /** Revisão manual: 'confirmed' (irregularidade real) ou 'false-alarm'. */
    review(id, verdict) {
      const f = findings.find((x) => x.id === id);
      if (!f) return false;
      if (verdict === 'confirmed') {
        f.level = LEVEL.CONFIRMED;
        f.status = 'reviewed';
        return true;
      }
      if (verdict === 'false-alarm') {
        f.status = 'dismissed';
        return true;
      }
      return false;
    },

    setSnapshotAllowed(value) {
      snapshotAllowed = value === true;
      if (!snapshotAllowed) findings.forEach((f) => { f.snapshot = null; });
    },
    isSnapshotAllowed() { return snapshotAllowed; },

    /** Guarda a captura (data URL) somente na memória e somente com autorização. */
    attachSnapshot(id, dataUrl) {
      if (!snapshotAllowed) return false;
      const f = findings.find((x) => x.id === id);
      if (!f || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return false;
      f.snapshot = dataUrl;
      return true;
    },

    /** Exporta os achados sem as imagens. */
    toJSON() {
      return findings.map(({ snapshot, ...rest }) => rest);
    },

    reset() {
      findings.length = 0;
      reported.clear();
      pending.clear();
    },
  };
}
