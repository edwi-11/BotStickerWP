// Descarga de videos de TikTok / YouTube con yt-dlp. NO sabe nada de WhatsApp.
// TikTok: yt-dlp ya prefiere el formato SIN marca de agua (los watermarked tienen menor prioridad).
import { spawn } from 'node:child_process';
import { readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

const YTDLP_BIN = process.env.YTDLP_BIN || 'yt-dlp';

/** Error cuyo mensaje es seguro para mostrarselo al usuario. */
export class SocialError extends Error {}

/** 'TikTok' | 'YouTube' | null segun el enlace. */
export function socialPlatform(rawUrl) {
  let host;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) return 'TikTok';
  if (host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com')) return 'YouTube';
  return null;
}

/** Busca un enlace de TikTok/YouTube en cualquier parte del texto (para chats privados). */
export function findSocialUrl(text) {
  if (typeof text !== 'string') return null;
  for (const m of text.matchAll(/https?:\/\/[^\s<>]+/gi)) {
    const url = m[0].replace(/[).,;!?]+$/, '');
    if (socialPlatform(url)) return url;
  }
  return null;
}

function friendlyError(stderr) {
  const s = stderr.toLowerCase();
  if (s.includes('sign in to confirm') || s.includes('not a bot')) {
    return 'YouTube bloqueo la descarga desde este servidor. Prueba con otro video o con un enlace de TikTok.';
  }
  if (s.includes('private') || s.includes('unavailable') || s.includes('removed') || s.includes('not available')) {
    return 'Ese video es privado o ya no esta disponible.';
  }
  if (s.includes('unsupported url')) return 'Ese enlace no es de un video.';
  if (s.includes('age') && s.includes('restricted')) return 'Ese video tiene restriccion de edad y no se puede descargar.';
  return 'No pude descargar ese video.';
}

function runYtDlp(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proc = spawn(YTDLP_BIN, args);
    let stderr = '';
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      proc.kill('SIGKILL');
      reject(new SocialError('La descarga tardo demasiado.'));
    }, timeoutMs);

    proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    proc.stdout.on('data', () => {});
    proc.on('error', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new SocialError('El descargador de videos (yt-dlp) no esta instalado en el servidor.'));
    });
    proc.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

function findDownloaded(dir) {
  const files = readdirSync(dir).filter((f) => f.startsWith('video.') && !f.endsWith('.part') && !f.endsWith('.ytdl'));
  return files.length ? path.join(dir, files[0]) : null;
}

/**
 * Descarga el video de `url` en `dir`. Si pesa mas de `maxMb`, reintenta con menos calidad.
 * @returns {Promise<{filePath: string, bytes: number}>}
 */
export async function downloadSocialVideo(url, { dir, maxMb = 16, maxMinutes = 10, height = 720, timeoutMs = 180_000 }) {
  const heights = [...new Set([height, 480, 360].filter((h) => h <= height))];
  const deadline = Date.now() + timeoutMs;
  let lastTooBig = false;

  for (const h of heights) {
    const remaining = deadline - Date.now();
    if (remaining < 5000) throw new SocialError('La descarga tardo demasiado.');

    const format =
      `bv*[height<=${h}][vcodec^=avc1]+ba[ext=m4a]/b[height<=${h}][ext=mp4]/` +
      `bv*[height<=${h}]+ba/b[height<=${h}]/b`;

    const args = [
      '--no-playlist', '--no-warnings', '--no-progress',
      '--socket-timeout', '15', '--retries', '2',
      '--js-runtimes', 'node',
      '--match-filters', `duration<=?${maxMinutes * 60}`,
      '--max-filesize', `${maxMb + 3}M`,
      '-f', format,
      '--merge-output-format', 'mp4',
      '-o', path.join(dir, 'video.%(ext)s'),
      url,
    ];

    const { code, stderr } = await runYtDlp(args, remaining);
    const file = findDownloaded(dir);

    if (!file) {
      if (stderr.toLowerCase().includes('does not pass filter')) {
        throw new SocialError(`El video dura mas de ${maxMinutes} minutos.`);
      }
      if (stderr.toLowerCase().includes('larger than max-filesize')) {
        lastTooBig = true;
        continue;
      }
      throw new SocialError(friendlyError(stderr));
    }
    if (code !== 0) throw new SocialError(friendlyError(stderr));

    const bytes = statSync(file).size;
    if (bytes <= maxMb * 1024 * 1024) return { filePath: file, bytes };

    lastTooBig = true;
    // demasiado pesado: se borra y se intenta con menos calidad
    rmSync(file, { force: true });
  }

  throw new SocialError(
    lastTooBig ? `El video pesa mas de ${maxMb} MB incluso en baja calidad.` : 'No pude descargar ese video.',
  );
}
