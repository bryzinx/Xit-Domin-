/* ==========================================================================
 * XIT DOMINÓ — xit-domino-camera.js
 * Acesso à câmera (MediaDevices.getUserMedia), troca de câmera (inclui câmera
 * externa USB), pausa e captura de quadros em ImageData.
 * Nada é enviado a servidores: os quadros ficam no aparelho.
 *
 * Segundo aparelho: não há como ligar dois celulares sem um servidor de
 * sinalização. A alternativa funcional é importar uma foto tirada pelo outro
 * aparelho (importImageFile) e analisá-la como se fosse um quadro.
 * ========================================================================== */

/** Verifica suporte e contexto seguro (HTTPS ou localhost). */
export function cameraSupport(env = globalThis) {
  const nav = env.navigator;
  const secure = env.isSecureContext !== false;
  if (!nav || !nav.mediaDevices || typeof nav.mediaDevices.getUserMedia !== 'function') {
    return {
      supported: false,
      secure,
      reason: secure
        ? 'Este navegador não permite acesso à câmera. Use o Chrome ou o Firefox atualizados.'
        : 'A câmera só funciona em páginas seguras (HTTPS). Abra o site pelo endereço https://.',
    };
  }
  if (!secure) {
    return { supported: false, secure, reason: 'A câmera só funciona em páginas seguras (HTTPS). Abra o site pelo endereço https://.' };
  }
  return { supported: true, secure, reason: '' };
}

/** Traduz erros do navegador para mensagens claras em português. */
export function describeCameraError(err) {
  const name = err && err.name ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'Permissão da câmera negada. Toque no cadeado ao lado do endereço do site, permita a câmera e tente de novo.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'Nenhuma câmera foi encontrada neste aparelho.';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'A câmera está em uso por outro aplicativo. Feche-o e tente novamente.';
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return 'A câmera escolhida não suporta a configuração pedida.';
    case 'TypeError':
      return 'Configuração de câmera inválida.';
    default:
      return `Não foi possível abrir a câmera${name ? ` (${name})` : ''}.`;
  }
}

export function buildConstraints({ deviceId, facingMode = 'environment', width = 1280, height = 720 } = {}) {
  const video = { width: { ideal: width }, height: { ideal: height } };
  if (deviceId) video.deviceId = { exact: deviceId };
  else video.facingMode = { ideal: facingMode };
  return { audio: false, video };
}

export async function listVideoDevices(nav = globalThis.navigator) {
  if (!nav || !nav.mediaDevices || !nav.mediaDevices.enumerateDevices) return [];
  const all = await nav.mediaDevices.enumerateDevices();
  return all
    .filter((d) => d.kind === 'videoinput')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Câmera ${i + 1}` }));
}

/**
 * @param {{video: HTMLVideoElement, env?: object}} deps
 */
export function createCamera({ video, env = globalThis }) {
  let stream = null;
  let paused = false;
  let canvas = null;
  let ctx = null;
  let loopTimer = null;
  let loopRunning = false;
  let currentDeviceId = null;

  function ensureCanvas(w, h) {
    if (!canvas) {
      canvas = env.document.createElement('canvas');
      ctx = canvas.getContext('2d', { willReadFrequently: true });
    }
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }

  function stopTracks() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  async function start(options = {}) {
    const support = cameraSupport(env);
    if (!support.supported) throw Object.assign(new Error(support.reason), { friendly: support.reason });
    stopTracks();
    try {
      try {
        stream = await env.navigator.mediaDevices.getUserMedia(buildConstraints(options));
      } catch (e) {
        if (e && (e.name === 'OverconstrainedError' || e.name === 'ConstraintNotSatisfiedError') && !options.deviceId) {
          stream = await env.navigator.mediaDevices.getUserMedia({ audio: false, video: true });
        } else throw e;
      }
    } catch (e) {
      const friendly = describeCameraError(e);
      throw Object.assign(new Error(friendly), { friendly, cause: e });
    }
    const settings = stream.getVideoTracks()[0] && stream.getVideoTracks()[0].getSettings
      ? stream.getVideoTracks()[0].getSettings() : {};
    currentDeviceId = settings.deviceId || options.deviceId || null;
    video.srcObject = stream;
    video.muted = true;
    video.setAttribute('playsinline', '');
    paused = false;
    await video.play();
    return { deviceId: currentDeviceId, width: video.videoWidth, height: video.videoHeight };
  }

  function stop() {
    stopLoop();
    stopTracks();
    video.srcObject = null;
    paused = false;
  }

  function pause() {
    if (!stream) return false;
    paused = true;
    video.pause();
    return true;
  }

  async function resume() {
    if (!stream) return false;
    paused = false;
    await video.play();
    return true;
  }

  /** Captura o quadro atual redimensionado para targetWidth (padrão 960 px). */
  function grabFrame(targetWidth = 960) {
    if (!stream || !video.videoWidth) return null;
    const scale = Math.min(1, targetWidth / video.videoWidth);
    const w = Math.round(video.videoWidth * scale);
    const h = Math.round(video.videoHeight * scale);
    ensureCanvas(w, h);
    ctx.drawImage(video, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    return { data: img.data, width: w, height: h };
  }

  /**
   * Imagem do quadro atual como data URL (capturas de alerta — somente local).
   * annotate: { region?: {x,y,w,h} normalizado, label?: string } desenha a marcação vermelha.
   */
  function snapshotDataUrl(quality = 0.8, annotate = null) {
    if (!stream || !video.videoWidth) return null;
    ensureCanvas(video.videoWidth, video.videoHeight);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    if (annotate) {
      const W = canvas.width;
      const H = canvas.height;
      ctx.save();
      ctx.lineWidth = Math.max(3, W / 200);
      ctx.strokeStyle = '#ff3b4e';
      ctx.fillStyle = '#ff3b4e';
      if (annotate.region) {
        const r = annotate.region;
        ctx.strokeRect(r.x * W, r.y * H, r.w * W, r.h * H);
      }
      if (annotate.label) {
        const size = Math.max(16, Math.round(W / 40));
        ctx.font = `bold ${size}px sans-serif`;
        const tw = ctx.measureText(annotate.label).width + 16;
        ctx.fillRect(8, 8, tw, size + 14);
        ctx.fillStyle = '#fff';
        ctx.fillText(annotate.label, 16, 8 + size);
      }
      ctx.restore();
    }
    return canvas.toDataURL('image/jpeg', quality);
  }

  /** Executa onFrame ~fps vezes por segundo enquanto a câmera estiver ativa e não pausada. */
  function startLoop(onFrame, fps = 5) {
    stopLoop();
    loopRunning = true;
    const interval = 1000 / fps;
    const tick = async () => {
      if (!loopRunning) return;
      const t0 = env.performance ? env.performance.now() : Date.now();
      if (stream && !paused && video.readyState >= 2) {
        try { await onFrame(); } catch (e) { /* o chamador trata erros próprios */ }
      }
      const spent = (env.performance ? env.performance.now() : Date.now()) - t0;
      loopTimer = env.setTimeout(tick, Math.max(30, interval - spent));
    };
    loopTimer = env.setTimeout(tick, interval);
  }

  function stopLoop() {
    loopRunning = false;
    if (loopTimer) env.clearTimeout(loopTimer);
    loopTimer = null;
  }

  return {
    start, stop, pause, resume, grabFrame, snapshotDataUrl, startLoop, stopLoop,
    isActive: () => !!stream,
    isPaused: () => paused,
    getDeviceId: () => currentDeviceId,
    devices: () => listVideoDevices(env.navigator),
  };
}

/** Lê um arquivo de imagem (foto de outro aparelho) e devolve um quadro analisável. */
export async function importImageFile(file, maxWidth = 1280, env = globalThis) {
  if (!file || !/^image\//.test(file.type || '')) throw new Error('Escolha um arquivo de imagem.');
  const bitmap = await env.createImageBitmap(file);
  const scale = Math.min(1, maxWidth / bitmap.width);
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = env.document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  if (bitmap.close) bitmap.close();
  const img = ctx.getImageData(0, 0, w, h);
  return { data: img.data, width: w, height: h };
}
