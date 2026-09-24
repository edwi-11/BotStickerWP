import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMessageHandler } from './src/handlers.js';
import { log } from './src/logger.js';
import { createWhatsAppBot } from './src/whatsapp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.resolve(__dirname, process.env.WA_AUTH_DIR || 'auth');
const TEMP_DIR = path.resolve(__dirname, process.env.TEMP_DIR || 'temp');

mkdirSync(TEMP_DIR, { recursive: true });

const startedAt = Date.now();

const dispatch = { handleMessage: async () => {} };
const bot = createWhatsAppBot({
  authDir: AUTH_DIR,
  onMessage: (sock, msg) => dispatch.handleMessage(sock, msg),
});
dispatch.handleMessage = createMessageHandler({ bot, tempDir: TEMP_DIR, startedAt });

process.on('unhandledRejection', (e) => log.error({ err: String(e) }, 'unhandledRejection'));
process.on('uncaughtException', (e) => log.error({ err: e.message }, 'uncaughtException'));

// Revisa las herramientas externas al arrancar: sin FFmpeg los videos fallan siempre.
for (const [name, args] of [
  [process.env.PYTHON_BIN || 'python3', ['-c', 'import PIL']],
  ['ffmpeg', ['-version']],
  ['ffprobe', ['-version']],
]) {
  const r = spawnSync(name, args, { stdio: 'ignore' });
  if (r.error || r.status !== 0) {
    log.error(`NO se encontro/funciona "${name}": los stickers (sobre todo de VIDEO) no se van a generar. Instalalo y reinicia.`);
  }
}

log.info('Iniciando bot de stickers de WhatsApp...');
bot.connect().catch((e) => {
  log.error({ err: e.message }, 'No se pudo iniciar la conexión con WhatsApp');
  process.exit(1);
});