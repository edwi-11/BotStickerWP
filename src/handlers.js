import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';

import path from 'node:path';
import crypto from 'node:crypto';

import { ConversionError, convertToSticker } from './converter.js';
import { extractLinkUrl, fetchLinkMedia, LinkError } from './linkfetch.js';
import { log } from './logger.js';

const MAX_DOWNLOAD_BYTES =
  Number(process.env.MAX_DOWNLOAD_MB || 20) *
  1024 *
  1024;

const LINK_TIMEOUT_MS =
  Number(process.env.LINK_TIMEOUT_MS || 45000);

const RATE_LIMIT_PER_MIN =
  Number(process.env.RATE_LIMIT_PER_MIN || 10);

const seenMessages = new Set();
const rateMap = new Map();

function getJid(msg) {
  return (
    msg?.key?.remoteJid ||
    msg?.key?.participant ||
    ''
  );
}

function unwrapMessage(message) {
  let current = message;

  if (!current) {
    return null;
  }

  if (current.ephemeralMessage?.message) {
    current =
      current.ephemeralMessage.message;
  }

  if (current.viewOnceMessage?.message) {
    current =
      current.viewOnceMessage.message;
  }

  if (current.viewOnceMessageV2?.message) {
    current =
      current.viewOnceMessageV2.message;
  }

  if (
    current.viewOnceMessageV2Extension?.message
  ) {
    current =
      current.viewOnceMessageV2Extension.message;
  }

  return current;
}

function getMessageContent(msg) {
  return unwrapMessage(msg?.message);
}

function extractText(msg) {
  const content =
    getMessageContent(msg);

  if (!content) {
    return '';
  }

  if (
    typeof content.conversation ===
    'string'
  ) {
    return content.conversation.trim();
  }

  if (
    typeof content.extendedTextMessage
      ?.text === 'string'
  ) {
    return content.extendedTextMessage.text.trim();
  }

  if (
    typeof content.imageMessage
      ?.caption === 'string'
  ) {
    return content.imageMessage.caption.trim();
  }

  if (
    typeof content.videoMessage
      ?.caption === 'string'
  ) {
    return content.videoMessage.caption.trim();
  }

  return '';
}

function extractMedia(msg) {
  const content =
    getMessageContent(msg);

  if (!content) {
    return null;
  }

  if (content.imageMessage) {
    return {
      kind: 'image',
      media: content.imageMessage,
    };
  }

  if (content.videoMessage) {
    return {
      kind: 'video',
      media: content.videoMessage,
    };
  }

  // Video/imagen enviado "como documento"
  const doc =
    content.documentMessage ||
    content.documentWithCaptionMessage?.message?.documentMessage;
  const mime = String(doc?.mimetype || '');
  if (doc && mime.startsWith('video/')) {
    return { kind: 'video', media: doc };
  }
  if (doc && mime.startsWith('image/')) {
    return { kind: 'image', media: doc };
  }

  return null;
}

function checkRateLimit(jid) {
  const now = Date.now();
  const minuteAgo =
    now - 60 * 1000;

  const values =
    rateMap.get(jid) || [];

  const recent =
    values.filter(
      (timestamp) =>
        timestamp > minuteAgo
    );

  if (
    recent.length >=
    RATE_LIMIT_PER_MIN
  ) {
    rateMap.set(
      jid,
      recent
    );

    return false;
  }

  recent.push(now);

  rateMap.set(
    jid,
    recent
  );

  return true;
}

function cleanupJobDir(jobDir) {
  try {
    if (existsSync(jobDir)) {
      rmSync(
        jobDir,
        {
          recursive: true,
          force: true,
        }
      );
    }
  } catch (e) {
    log.warn(
      {
        err:
          e?.message ||
          String(e),
        jobDir,
      },
      'No se pudo eliminar la carpeta temporal'
    );
  }
}

async function sendText(
  bot,
  jid,
  text,
  quoted
) {
  log.info(
    {
      jid,
      text,
    },
    'Intentando enviar mensaje de texto'
  );

  const result =
    await bot.sendText(
      jid,
      text,
      quoted
        ? {
            quoted,
          }
        : {}
    );

  log.info(
    {
      jid,
      messageId:
        result?.key?.id ||
        null,
    },
    'MENSAJE DE TEXTO ENVIADO CORRECTAMENTE'
  );

  return result;
}

export function createMessageHandler({
  bot,
  tempDir,
  startedAt,
  linkOptions = {}, // solo para pruebas (p. ej. allowHostPorts); en produccion queda vacio
}) {
  mkdirSync(
    tempDir,
    {
      recursive: true,
    }
  );

  // Convierte un archivo local (imagen/video) en sticker, lo envia y borra el
  // mensaje de "Procesando...". Lo usan tanto los archivos como los enlaces.
  async function convertAndReply({
    sock,
    jid,
    msg,
    inputPath,
    jobDir,
    kind,
    processing,
  }) {
    log.info(
      {
        jid,
        kind,
        inputPath,
      },
      'Iniciando conversion a sticker'
    );

    const conversionResult =
      await convertToSticker(
        inputPath,
        jobDir,
        kind
      );

    const resultPath =
      typeof conversionResult ===
      'string'
        ? conversionResult
        : conversionResult?.path;

    log.info(
      {
        jid,
        conversionResult,
        resultPath,
      },
      'Conversion terminada'
    );

    if (
      !resultPath ||
      !existsSync(
        resultPath
      )
    ) {
      throw new Error(
        'La conversion no genero un archivo valido.'
      );
    }

    const resultStats =
      statSync(
        resultPath
      );

    if (
      resultStats.size === 0
    ) {
      throw new Error(
        'El archivo WebP generado esta vacio.'
      );
    }

    const stickerBuffer =
      readFileSync(
        resultPath
      );

    log.info(
      {
        jid,
        stickerBytes:
          stickerBuffer.length,
      },
      'Sticker leido correctamente'
    );

    await bot.sendSticker(
      jid,
      stickerBuffer,
      {
        quoted: msg,
        animated: Boolean(conversionResult?.animated),
      }
    );

    log.info(
      {
        jid,
        stickerBytes:
          stickerBuffer.length,
      },
      'STICKER ENVIADO CORRECTAMENTE'
    );

    try {
      if (
        processing?.key
      ) {
        await sock.sendMessage(
          jid,
          {
            delete:
              processing.key,
          }
        );
      }
    } catch (e) {
      log.warn(
        {
          jid,
          err:
            e?.message ||
            String(e),
        },
        'No se pudo eliminar el mensaje de procesamiento'
      );
    }
  }

  // Mensaje que es SOLO un enlace: descarga su imagen/video (o la vista previa de la
  // pagina) y lo convierte en sticker.
  async function handleLink({ sock, jid, msg, linkUrl }) {
    log.info({ jid, linkUrl }, 'Enlace detectado');

    if (!checkRateLimit(jid)) {
      await sendText(
        bot,
        jid,
        'Demasiados archivos en poco tiempo. Espera un momento e intenta nuevamente.',
        msg
      );

      return;
    }

    const processing = await sendText(bot, jid, 'Descargando enlace...', msg);

    const jobDir = path.join(
      tempDir,
      String(Date.now()) + '-' + crypto.randomBytes(16).toString('hex').toUpperCase()
    );

    mkdirSync(jobDir, { recursive: true });

    try {
      const fetched = await fetchLinkMedia(linkUrl, {
        dir: jobDir,
        maxBytes: MAX_DOWNLOAD_BYTES,
        timeoutMs: LINK_TIMEOUT_MS,
        ...linkOptions,
      });

      log.info(
        { jid, kind: fetched.kind, sourceUrl: fetched.sourceUrl },
        'Enlace descargado'
      );

      await convertAndReply({
        sock,
        jid,
        msg,
        inputPath: fetched.filePath,
        jobDir,
        kind: fetched.kind,
        processing,
      });
    } catch (e) {
      // Los mensajes de LinkError/ConversionError son seguros para mostrarselos al usuario.
      const userMessage =
        e instanceof LinkError || e instanceof ConversionError
          ? e.message
          : 'No pude convertir ese enlace en sticker.';

      log.warn(
        { jid, linkUrl, err: e?.stack || e?.message || String(e) },
        'Error procesando enlace'
      );

      try {
        if (processing?.key) {
          await sock.sendMessage(jid, { delete: processing.key });
        }
      } catch {
        // no es critico
      }

      await sendText(bot, jid, userMessage, msg);
    } finally {
      cleanupJobDir(jobDir);
    }
  }


  // Descarga `source` (mensaje con imagen/video), lo convierte y responde citando `msg`.
  async function handleMedia({ sock, jid, msg, media, source, rateKey }) {
    if (!checkRateLimit(rateKey)) {
      await sendText(bot, jid, 'Demasiados archivos en poco tiempo. Espera un momento e intenta nuevamente.', msg);
      return;
    }

    const maxMb = Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024);
    const declaredSize = Number(media.media?.fileLength || 0);

    if (declaredSize > MAX_DOWNLOAD_BYTES) {
      await sendText(bot, jid, 'El archivo pesa demasiado. Maximo permitido: ' + maxMb + ' MB.', msg);
      return;
    }

    const processing = await sendText(
      bot,
      jid,
      media.kind === 'video' ? 'Procesando video...' : 'Procesando imagen...',
      msg
    );

    const jobDir = path.join(
      tempDir,
      String(Date.now()) + '-' + crypto.randomBytes(16).toString('hex').toUpperCase()
    );
    mkdirSync(jobDir, { recursive: true });

    try {
      const buffer = await bot.downloadMedia(source);

      if (!buffer || buffer.length === 0) {
        throw new Error('La descarga devolvio un buffer vacio.');
      }
      if (buffer.length > MAX_DOWNLOAD_BYTES) {
        await sendText(bot, jid, 'El archivo supera el limite de ' + maxMb + ' MB.', msg);
        return;
      }

      const inputPath = path.join(jobDir, 'input.bin');
      writeFileSync(inputPath, buffer);

      await convertAndReply({
        sock,
        jid,
        msg,
        inputPath,
        jobDir,
        kind: media.kind,
        processing,
      });
    } catch (e) {
      log.error(
        { jid, kind: media.kind, err: e?.stack || e?.message || String(e) },
        'Error procesando multimedia'
      );

      try {
        if (processing?.key) {
          await sock.sendMessage(jid, { delete: processing.key });
        }
      } catch {
        // no es critico
      }

      await sendText(
        bot,
        jid,
        e instanceof ConversionError
          ? e.message
          : 'No pude convertir ese archivo en sticker. Intenta con otra imagen o video.',
        msg
      );
    } finally {
      cleanupJobDir(jobDir);
    }
  }

  // En grupos el bot SOLO actua con "/s" (responder a una foto/video, o /s en el pie de la
  // foto/video, o "/s <enlace>"). Todo lo demas se ignora para no molestar al grupo.
  async function handleGroup({ sock, jid, msg, content, text }) {
    const first = text.split(/\s+/)[0].toLowerCase();

    if (first === '/menu' || first === '/ayuda' || first === '/help') {
      await sendText(
        bot,
        jid,
        [
          'BOT DE STICKERS',
          '',
          'Responde a una foto o video con /s y lo convierto en sticker.',
          'Tambien funciona con un enlace: /s <enlace>',
        ].join('\n'),
        msg
      );
      return;
    }

    if (first !== '/s' && first !== '/sticker') {
      return;
    }

    const sender = msg.key?.participant || msg.key?.participantAlt || jid;
    const rateKey = jid + '|' + sender;

    // a) /s <enlace>
    const ownLink = extractLinkUrl(text);
    if (ownLink) {
      await handleLink({ sock, jid, msg, linkUrl: ownLink });
      return;
    }

    // b) foto/video enviado con "/s" como pie de foto
    const ownMedia = extractMedia(msg);
    if (ownMedia) {
      await handleMedia({ sock, jid, msg, media: ownMedia, source: msg, rateKey });
      return;
    }

    // c) respondiendo a un mensaje
    const ctx =
      content.extendedTextMessage?.contextInfo ||
      content.imageMessage?.contextInfo ||
      content.videoMessage?.contextInfo;
    const quoted = ctx?.quotedMessage;

    if (quoted && ctx?.stanzaId) {
      const quotedMedia = extractMedia({ message: quoted });

      if (quotedMedia) {
        const source = {
          key: {
            remoteJid: jid,
            id: ctx.stanzaId,
            participant: ctx.participant,
            fromMe: false,
          },
          message: quoted,
        };
        await handleMedia({ sock, jid, msg, media: quotedMedia, source, rateKey });
        return;
      }

      // respondiendo a un mensaje que es solo un enlace
      const quotedLink = extractLinkUrl(extractText({ message: quoted }));
      if (quotedLink) {
        await handleLink({ sock, jid, msg, linkUrl: quotedLink });
        return;
      }
    }

    await sendText(bot, jid, 'Responde a una foto o video con /s para crear el sticker.', msg);
  }

  return async function handleMessage(
    sock,
    msg
  ) {
    try {
      if (!msg?.message) {
        return;
      }

      // Ignora lo que envia la propia cuenta del bot (el bot es un dispositivo
      // vinculado de ese numero): si no, podria responder en cualquier chat tuyo.
      const isGroupChat = String(msg.key?.remoteJid || '').endsWith('@g.us');

      if (msg.key?.fromMe && !isGroupChat) {
        return;
      }

      const messageId =
        msg.key?.id;

      if (
        messageId &&
        seenMessages.has(messageId)
      ) {
        return;
      }

      if (messageId) {
        seenMessages.add(
          messageId
        );

        if (
          seenMessages.size >
          5000
        ) {
          const first =
            seenMessages
              .values()
              .next()
              .value;

          if (first) {
            seenMessages.delete(
              first
            );
          }
        }
      }

      const jid =
        getJid(msg);

      if (
        !jid ||
        jid === 'status@broadcast' ||
        jid.endsWith('@broadcast') ||
        jid.endsWith('@newsletter')
      ) {
        return;
      }

      log.info(
        {
          from: jid,
          tipos: Object.keys(
            msg.message || {}
          ),
        },
        'Mensaje recibido'
      );

      const content =
        getMessageContent(msg);

      if (!content) {
        return;
      }

      log.info(
        {
          tiposDesenvueltos:
            Object.keys(content),
        },
        'Contenido del mensaje analizado'
      );

      const text =
        extractText(msg);

      if (jid.endsWith('@g.us')) {
        await handleGroup({ sock, jid, msg, content, text });
        return;
      }

      if (text) {
        log.info(
          {
            jid,
            text,
          },
          'Texto detectado'
        );

        const command =
          text
            .split(/\s+/)[0]
            .toLowerCase();

        if (
          command === '/menu' ||
          command === '/ayuda' ||
          command === '/help'
        ) {
          log.info(
            {
              jid,
            },
            'Comando /menu detectado'
          );

          await sendText(
            bot,
            jid,
            [
              'BOT DE STICKERS',
              '',
              'Enviame una foto o video y lo convertire en sticker.',
              'Tambien puedes enviarme un enlace a una imagen, GIF o video (o a una pagina con imagen) y lo convierto.',
              '',
              'Comandos:',
              'En grupos: responde a una foto o video con /s.',
              '/menu - Ver este menu',
              '/status - Estado del bot',
            ].join('\n'),
            msg
          );

          return;
        }

        if (
          command === '/status'
        ) {
          log.info(
            {
              jid,
            },
            'Comando /status detectado'
          );

          const status =
            bot.getStatus();

          const uptime =
            Math.floor(
              (Date.now() -
                startedAt) /
                1000
            );

          await sendText(
            bot,
            jid,
            [
              'ESTADO DEL BOT',
              '',
              'WhatsApp: ' +
                status.state,
              'Conectado como: ' +
                (status.me ||
                  'desconocido'),
              'Uptime: ' +
                uptime +
                ' segundos',
            ].join('\n'),
            msg
          );

          return;
        }
      }

      if (text && !content.imageMessage && !content.videoMessage) {
        const linkUrl = extractLinkUrl(text);

        if (linkUrl) {
          await handleLink({ sock, jid, msg, linkUrl });

          return;
        }
      }

      const media = extractMedia(msg);

      if (!media) {
        return;
      }

      await handleMedia({ sock, jid, msg, media, source: msg, rateKey: jid });
    } catch (e) {
      log.error(
        {
          err:
            e?.stack ||
            e?.message ||
            String(e),
        },
        'Error general en el handler'
      );
    }
  };
}