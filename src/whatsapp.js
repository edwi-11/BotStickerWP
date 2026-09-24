import { mkdirSync, rmSync } from 'node:fs';

import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

import qrcodeTerminal from 'qrcode-terminal';

import { baileysLog, log, silentLog } from './logger.js';

const PAIRING_NUMBER =
  (process.env.WA_PAIRING_NUMBER || '').replace(/\D/g, '');

export function createWhatsAppBot({ authDir, onMessage }) {
  mkdirSync(authDir, { recursive: true });

  // Cache de mensajes enviados. Baileys la necesita (getMessage) para reenviar un
  // mensaje cuando el otro telefono pide reintento; sin ella queda "Esperando este mensaje".
  const sentCache = new Map();

  function remember(result) {
    if (!result?.key?.id || !result.message) {
      return;
    }

    sentCache.set(result.key.id, result.message);

    if (sentCache.size > 500) {
      sentCache.delete(sentCache.keys().next().value);
    }
  }

  const status = {
    state: 'starting',
    startedAt: Date.now(),
    me: null,
  };

  let sock = null;
  let retries = 0;
  let pairingRequested = false;

  async function connect() {
    const {
      state: authState,
      saveCreds,
    } = await useMultiFileAuthState(authDir);

    const { version } =
      await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: authState,
      logger: baileysLog,
      getMessage: async (key) => sentCache.get(key.id),
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    });

    sock.ev.on(
      'creds.update',
      saveCreds
    );

    sock.ev.on(
      'connection.update',
      async (u) => {
        const {
          connection,
          lastDisconnect,
          qr,
        } = u;

        if (qr) {
          if (
            PAIRING_NUMBER &&
            !sock.authState.creds.registered
          ) {
            if (!pairingRequested) {
              pairingRequested = true;

              try {
                const code =
                  await sock.requestPairingCode(
                    PAIRING_NUMBER
                  );

                status.state = 'pairing';

                log.warn(
                  'Codigo de vinculacion de WhatsApp: ' +
                    code +
                    ' (WhatsApp > Dispositivos vinculados > Vincular con numero de telefono)'
                );
              } catch (e) {
                log.error(
                  {
                    err:
                      e?.message ||
                      String(e),
                  },
                  'No se pudo generar el codigo de vinculacion'
                );
              }
            }
          } else {
            status.state = 'qr';

            qrcodeTerminal.generate(
              qr,
              {
                small: true,
              }
            );

            log.warn(
              'Escanea el codigo QR: WhatsApp > Dispositivos vinculados > Vincular un dispositivo'
            );
          }
        }

        if (connection === 'open') {
          status.state = 'connected';

          status.me =
            sock.user?.id ?? null;

          retries = 0;
          pairingRequested = false;

          log.info(
            'WhatsApp conectado como ' +
              (status.me ?? 'desconocido')
          );
        }

        if (connection === 'close') {
          status.state = 'disconnected';
          status.me = null;

          const code =
            lastDisconnect?.error?.output?.statusCode;

          if (
            code === DisconnectReason.loggedOut
          ) {
            status.state = 'logged_out';

            log.error(
              'Sesion cerrada desde el telefono. Borrando credenciales; hay que volver a vincular.'
            );

            rmSync(
              authDir,
              {
                recursive: true,
                force: true,
              }
            );

            mkdirSync(
              authDir,
              {
                recursive: true,
              }
            );
          }

          retries += 1;
          pairingRequested = false;

          const delay = Math.min(
            60000,
            1000 *
              2 **
                Math.min(retries, 6)
          );

          log.warn(
            {
              code,
              delay,
            },
            'Conexion de WhatsApp perdida; reconectando'
          );

          setTimeout(
            connect,
            delay
          );
        }
      }
    );

    sock.ev.on(
      'messages.upsert',
      async ({ messages, type }) => {
        if (type !== 'notify') {
          return;
        }

        for (const msg of messages) {
          try {
            await onMessage(
              sock,
              msg
            );
          } catch (e) {
            log.error(
              {
                err:
                  e?.stack ||
                  e?.message ||
                  String(e),
              },
              'Error manejando mensaje entrante'
            );
          }
        }
      }
    );
  }

  async function sendText(
    jid,
    text,
    options = {}
  ) {
    if (!sock) {
      throw new Error(
        'WhatsApp no esta conectado.'
      );
    }

    log.info(
      {
        jid,
        text,
        connected: Boolean(sock.user),
      },
      'Preparando envio de texto'
    );

    try {
      const result =
        await sock.sendMessage(
          jid,
          {
            text: String(text),
          },
          options
        );

      remember(result);

      log.info(
        {
          jid,
          messageId:
            result?.key?.id || null,
        },
        'Texto enviado por sendText'
      );

      return result;
    } catch (e) {
      log.error(
        {
          jid,
          err:
            e?.stack ||
            e?.message ||
            String(e),
        },
        'ERROR ENVIANDO TEXTO'
      );

      throw e;
    }
  }

  async function sendSticker(
    jid,
    stickerBuffer,
    options = {}
  ) {
    if (!sock) {
      throw new Error(
        'WhatsApp no esta conectado.'
      );
    }

    if (
      !Buffer.isBuffer(
        stickerBuffer
      )
    ) {
      throw new Error(
        'El sticker debe ser un Buffer.'
      );
    }

    if (
      stickerBuffer.length === 0
    ) {
      throw new Error(
        'El buffer del sticker esta vacio.'
      );
    }

    log.info(
      {
        jid,
        bytes: stickerBuffer.length,
        mimeType: 'image/webp',
      },
      'Preparando envio de sticker'
    );

    const { animated, ...sendOptions } = options;

    try {
      const result =
        await sock.sendMessage(
          jid,
          {
            sticker: stickerBuffer,
            mimetype: 'image/webp',
            isAnimated: Boolean(animated),
          },
          sendOptions
        );

      remember(result);

      log.info(
        {
          jid,
          bytes: stickerBuffer.length,
          messageId:
            result?.key?.id || null,
        },
        'Sticker enviado por sendSticker'
      );

      return result;
    } catch (e) {
      log.error(
        {
          jid,
          err:
            e?.stack ||
            e?.message ||
            String(e),
        },
        'ERROR ENVIANDO STICKER'
      );

      throw e;
    }
  }

  async function downloadMedia(msg) {
    if (!sock) {
      throw new Error(
        'WhatsApp no esta conectado.'
      );
    }

    return await downloadMediaMessage(
      msg,
      'buffer',
      {},
      {
        logger: silentLog,
      }
    );
  }

  return {
    connect,
    getStatus: () => status,
    downloadMedia,
    sendText,
    sendSticker,
  };
}