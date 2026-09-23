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

import { convertToSticker } from './converter.js';
import { log } from './logger.js';

const MAX_DOWNLOAD_BYTES =
  Number(process.env.MAX_DOWNLOAD_MB || 20) *
  1024 *
  1024;

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
}) {
  mkdirSync(
    tempDir,
    {
      recursive: true,
    }
  );

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
      if (msg.key?.fromMe) {
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
              '',
              'Comandos:',
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

      const media =
        extractMedia(msg);

      log.info(
        {
          jid,
          media:
            media?.kind ||
            null,
          hasImage:
            Boolean(
              content.imageMessage
            ),
          hasVideo:
            Boolean(
              content.videoMessage
            ),
        },
        'Media detectada'
      );

      if (!media) {
        return;
      }

      if (
        !checkRateLimit(jid)
      ) {
        await sendText(
          bot,
          jid,
          'Demasiados archivos en poco tiempo. Espera un momento e intenta nuevamente.',
          msg
        );

        return;
      }

      const declaredSize =
        Number(
          media.media
            ?.fileLength || 0
        );

      log.info(
        {
          jid,
          kind: media.kind,
          declaredSize,
          maxBytes:
            MAX_DOWNLOAD_BYTES,
        },
        'Comprobando tamano del archivo'
      );

      if (
        declaredSize >
        MAX_DOWNLOAD_BYTES
      ) {
        const maxMb =
          Math.round(
            MAX_DOWNLOAD_BYTES /
              1024 /
              1024
          );

        await sendText(
          bot,
          jid,
          'El archivo pesa demasiado. Maximo permitido: ' +
            maxMb +
            ' MB.',
          msg
        );

        return;
      }

      log.info(
        {
          jid,
          kind: media.kind,
        },
        'Enviando mensaje de procesamiento'
      );

      const processing =
        await sendText(
          bot,
          jid,
          media.kind ===
          'video'
            ? 'Procesando video...'
            : 'Procesando imagen...',
          msg
        );

      log.info(
        {
          jid,
          messageId:
            processing?.key?.id ||
            null,
        },
        'Mensaje de procesamiento enviado'
      );

      const jobDir =
        path.join(
          tempDir,
          String(Date.now()) +
            '-' +
            crypto
              .randomBytes(16)
              .toString('hex')
              .toUpperCase()
        );

      mkdirSync(
        jobDir,
        {
          recursive: true,
        }
      );

      log.info(
        {
          jid,
          jobDir,
        },
        'Carpeta temporal creada'
      );

      try {
        log.info(
          {
            jid,
            kind: media.kind,
          },
          'Iniciando descarga del multimedia'
        );

        const buffer =
          await bot.downloadMedia(
            msg
          );

        if (
          !buffer ||
          buffer.length === 0
        ) {
          throw new Error(
            'La descarga devolvio un buffer vacio.'
          );
        }

        log.info(
          {
            jid,
            bytes:
              buffer.length,
          },
          'Multimedia descargado'
        );

        if (
          buffer.length >
          MAX_DOWNLOAD_BYTES
        ) {
          const maxMb =
            Math.round(
              MAX_DOWNLOAD_BYTES /
                1024 /
                1024
            );

          await sendText(
            bot,
            jid,
            'El archivo supera el limite de ' +
              maxMb +
              ' MB.',
            msg
          );

          return;
        }

        const inputPath =
          path.join(
            jobDir,
            'input.bin'
          );

        writeFileSync(
          inputPath,
          buffer
        );

        log.info(
          {
            jid,
            inputPath,
            bytes:
              buffer.length,
          },
          'Archivo multimedia guardado'
        );

        log.info(
          {
            jid,
            kind: media.kind,
            inputPath,
          },
          'Iniciando conversion a sticker'
        );

        const conversionResult =
          await convertToSticker(
            inputPath,
            jobDir,
            media.kind
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
      } catch (e) {
        log.error(
          {
            jid,
            kind: media.kind,
            err:
              e?.stack ||
              e?.message ||
              String(e),
          },
          'Error procesando multimedia'
        );

        await sendText(
          bot,
          jid,
          'No pude convertir ese archivo en sticker. Intenta con otra imagen o video.',
          msg
        );
      } finally {
        cleanupJobDir(
          jobDir
        );

        log.info(
          {
            jid,
            jobDir,
          },
          'Archivos temporales eliminados'
        );
      }
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