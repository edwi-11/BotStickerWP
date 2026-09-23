// Descarga segura del contenido de un enlace: NO sabe nada de WhatsApp/Baileys.
//
// Casos que cubre:
//   1) enlace directo a un archivo (imagen / GIF / video)  -> lo descarga.
//   2) enlace a una pagina web -> busca su imagen o video de vista previa
//      (etiquetas og:video / og:image / twitter:image ...) y descarga eso.
//
// Como el enlace lo manda cualquiera, se protege contra SSRF (que alguien haga que
// el bot abra localhost o la red interna): solo http/https, puertos 80/443, sin
// credenciales en la URL, y CADA salto (tambien las redirecciones) se resuelve por DNS
// y se rechaza si apunta a una IP privada/local. La conexion se fija a la IP ya
// validada, asi que tampoco sirve el "DNS rebinding". Ademas hay limites de tamano,
// de redirecciones y de tiempo.
import dns from 'node:dns/promises';
import { writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';

import { log } from './logger.js';

/** Error cuyo mensaje es seguro y util para mostrarselo al usuario. */
export class LinkError extends Error {}

const MAX_REDIRECTS = 5;
const MAX_CANDIDATES = 4;
const MAX_HTML_BYTES = 1024 * 1024; // las etiquetas <meta> estan al principio de la pagina
const ALLOWED_PORTS = new Set(['', '80', '443']);
const USER_AGENT = 'Mozilla/5.0 (compatible; WhatsAppStickerBot/1.0)';

// ---------------------------------------------------------------------------
// Extraer el enlace del mensaje
// ---------------------------------------------------------------------------

/**
 * Devuelve la URL si el mensaje es SOLO un enlace (o "/sticker <enlace>").
 * Un enlace dentro de una frase se ignora, para no responder a cualquier charla.
 */
export function extractLinkUrl(text) {
  if (typeof text !== 'string') return null;
  const m = text.trim().match(/^(?:\/sticker\s+)?<?(https?:\/\/[^\s<>]+)>?$/i);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Validacion de direcciones (SSRF)
// ---------------------------------------------------------------------------

const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
]) {
  blocked.addSubnet(addr, prefix, 'ipv4');
}
for (const [addr, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001::', 32],
  ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) {
  blocked.addSubnet(addr, prefix, 'ipv6');
}

/** true si `ip` es una direccion publica (no privada, local, multicast, etc.). */
export function isPublicAddress(ip) {
  const family = net.isIP(ip);
  if (!family) return false;

  if (family === 6) {
    const lower = ip.toLowerCase();
    // IPv4 "disfrazada" de IPv6: se valida la IPv4 que lleva dentro.
    const dotted = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) return isPublicAddress(dotted[1]);
    const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const a = parseInt(hex[1], 16);
      const b = parseInt(hex[2], 16);
      return isPublicAddress(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`);
    }
  }

  return !blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

function isAllowlisted(url, allowHostPorts) {
  if (!allowHostPorts?.length) return false;
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return allowHostPorts.includes(`${url.hostname}:${port}`);
}

function checkUrl(rawUrl, opts) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new LinkError('Ese enlace no es valido.');
  }
  const allowed = isAllowlisted(url, opts.allowHostPorts);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new LinkError('Solo acepto enlaces http o https.');
  }
  if (url.username || url.password) {
    throw new LinkError('No acepto enlaces con usuario o contrasena.');
  }
  if (!allowed && !ALLOWED_PORTS.has(url.port)) {
    throw new LinkError('Ese enlace no esta permitido.');
  }
  return { url, allowed };
}

/** Resuelve el host y devuelve UNA direccion publica ya validada (que luego se fija). */
async function resolveSafe(url, allowed) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const literal = net.isIP(host);
  const addresses = literal
    ? [{ address: host, family: literal }]
    : await dns.lookup(host, { all: true, verbatim: true }).catch(() => {
        throw new LinkError('No pude encontrar ese sitio.');
      });

  if (!addresses.length) throw new LinkError('No pude encontrar ese sitio.');
  if (!allowed && addresses.some((a) => !isPublicAddress(a.address))) {
    throw new LinkError('Ese enlace no esta permitido.');
  }
  return addresses.find((a) => a.family === 4) || addresses[0];
}

// ---------------------------------------------------------------------------
// Peticion HTTP con conexion fijada a la IP validada
// ---------------------------------------------------------------------------

function requestOnce(url, { address, family }, signal) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || undefined,
        path: url.pathname + url.search,
        method: 'GET',
        agent: false,
        signal,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'image/*,video/*,text/html;q=0.8,*/*;q=0.5',
          'Accept-Encoding': 'gzip, deflate, br',
        },
        // Fuerza a conectar a la IP que ya validamos (evita DNS rebinding).
        lookup: (_host, options, cb) =>
          options && options.all
            ? cb(null, [{ address, family }])
            : cb(null, address, family),
      },
      resolve,
    );
    req.on('error', reject);
    req.end();
  });
}

/** Abre la URL siguiendo redirecciones a mano, validando cada salto. */
async function openUrl(startUrl, opts) {
  let current = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const { url, allowed } = checkUrl(current, opts);
    const target = await resolveSafe(url, allowed);
    const res = await requestOnce(url, target, opts.signal);
    const status = res.statusCode || 0;

    if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
      res.resume();
      try {
        current = new URL(res.headers.location, url).toString();
      } catch {
        throw new LinkError('El enlace tiene una redireccion invalida.');
      }
      continue;
    }

    if (status < 200 || status >= 300) {
      res.resume();
      throw new LinkError(`El sitio respondio con un error (${status}).`);
    }

    return {
      res,
      finalUrl: url,
      contentType: String(res.headers['content-type'] || '')
        .split(';')[0]
        .trim()
        .toLowerCase(),
      contentLength: Number(res.headers['content-length'] || 0),
    };
  }

  throw new LinkError('El enlace tiene demasiadas redirecciones.');
}

// ---------------------------------------------------------------------------
// Lectura del cuerpo con limites
// ---------------------------------------------------------------------------

function bodyStream(res) {
  const enc = String(res.headers['content-encoding'] || '').toLowerCase();
  if (enc === 'gzip' || enc === 'x-gzip') return res.pipe(zlib.createGunzip());
  if (enc === 'deflate') return res.pipe(zlib.createInflate());
  if (enc === 'br') return res.pipe(zlib.createBrotliDecompress());
  return res;
}

/** Lee como maximo `maxBytes` (para el HTML): si hay mas, se corta sin error. */
async function readCapped(res, maxBytes) {
  const chunks = [];
  let total = 0;
  const stream = bodyStream(res);
  for await (const chunk of stream) {
    chunks.push(chunk);
    total += chunk.length;
    if (total >= maxBytes) {
      res.destroy();
      break;
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Descarga completa con tope: si se pasa de `maxBytes` es un error. */
async function readLimited(res, maxBytes) {
  const chunks = [];
  let total = 0;
  const stream = bodyStream(res);
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > maxBytes) {
      res.destroy();
      throw new LinkError(
        `El archivo pesa mas de ${Math.round(maxBytes / 1024 / 1024)} MB.`,
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Buscar imagen/video en una pagina web
// ---------------------------------------------------------------------------

function decodeEntities(s) {
  return s
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

function parseAttrs(tag) {
  const attrs = {};
  const re = /([a-zA-Z_:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(tag))) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

const VIDEO_KEYS = ['og:video', 'og:video:url', 'og:video:secure_url', 'twitter:player:stream'];
const IMAGE_KEYS = ['og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image', 'twitter:image:src'];

/** Devuelve URLs candidatas (video primero, luego imagen), absolutas y sin repetir. */
export function extractMediaCandidates(html, baseUrl) {
  const found = new Map(); // clave meta -> [urls]
  const push = (key, value) => {
    if (!value) return;
    if (!found.has(key)) found.set(key, []);
    found.get(key).push(value.trim());
  };

  for (const tag of html.match(/<meta\s[^>]*>/gi) || []) {
    const a = parseAttrs(tag);
    push((a.property || a.name || '').toLowerCase(), a.content);
  }
  for (const tag of html.match(/<link\s[^>]*>/gi) || []) {
    const a = parseAttrs(tag);
    if ((a.rel || '').toLowerCase() === 'image_src') push('image_src', a.href);
  }

  const ordered = [];
  for (const key of [...VIDEO_KEYS, ...IMAGE_KEYS, 'image_src']) {
    ordered.push(...(found.get(key) || []));
  }

  const out = [];
  for (const raw of ordered) {
    try {
      const abs = new URL(raw, baseUrl);
      if ((abs.protocol === 'http:' || abs.protocol === 'https:') && !out.includes(abs.href)) {
        out.push(abs.href);
      }
    } catch {
      // URL invalida: se ignora
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// API principal
// ---------------------------------------------------------------------------

function mediaKind(contentType) {
  if (contentType === 'image/svg+xml') return null; // no se puede convertir
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('video/')) return 'video';
  if (
    !contentType ||
    contentType === 'application/octet-stream' ||
    contentType === 'binary/octet-stream'
  ) {
    return 'unknown'; // el conversor decide mirando los bytes reales
  }
  return null;
}

function isHtml(contentType) {
  return contentType === 'text/html' || contentType === 'application/xhtml+xml';
}

/**
 * Descarga la imagen/video al que apunta `url` (directo o via vista previa de la pagina).
 *
 * @param {string} url
 * @param {{dir: string, maxBytes?: number, timeoutMs?: number, allowHostPorts?: string[]}} options
 *   `allowHostPorts` (["127.0.0.1:8080"]) existe solo para pruebas locales.
 * @returns {Promise<{filePath: string, kind: 'image'|'video'|'unknown', sourceUrl: string}>}
 * @throws {LinkError} con un mensaje seguro para mostrar al usuario.
 */
export async function fetchLinkMedia(url, options) {
  const {
    dir,
    maxBytes = 20 * 1024 * 1024,
    timeoutMs = 20_000,
    allowHostPorts = [],
  } = options;
  const opts = { signal: AbortSignal.timeout(timeoutMs), allowHostPorts };

  const save = async (opened) => {
    if (opened.contentLength > maxBytes) {
      opened.res.destroy();
      throw new LinkError(`El archivo pesa mas de ${Math.round(maxBytes / 1024 / 1024)} MB.`);
    }
    const buffer = await readLimited(opened.res, maxBytes);
    if (buffer.length === 0) throw new LinkError('El enlace devolvio un archivo vacio.');
    const filePath = path.join(dir, 'input.bin');
    writeFileSync(filePath, buffer);
    return filePath;
  };

  try {
    const first = await openUrl(url, opts);
    const firstKind = mediaKind(first.contentType);

    // 1) Enlace directo a un archivo
    if (firstKind) {
      return { filePath: await save(first), kind: firstKind, sourceUrl: first.finalUrl.href };
    }

    // 2) Pagina web: buscar su imagen/video de vista previa
    if (isHtml(first.contentType)) {
      const html = await readCapped(first.res, MAX_HTML_BYTES);
      const candidates = extractMediaCandidates(html, first.finalUrl).slice(0, MAX_CANDIDATES);
      log.info({ url, candidatos: candidates.length }, 'Enlace es una pagina; buscando vista previa');

      for (const candidate of candidates) {
        try {
          const opened = await openUrl(candidate, opts);
          const kind = mediaKind(opened.contentType);
          if (!kind) {
            opened.res.destroy(); // p. ej. un reproductor incrustado (HTML): probar el siguiente
            continue;
          }
          return { filePath: await save(opened), kind, sourceUrl: opened.finalUrl.href };
        } catch (e) {
          if (opts.signal.aborted) throw e;
          log.warn({ candidate, err: e?.message }, 'Candidato de vista previa descartado');
        }
      }
      throw new LinkError('No encontre una imagen o video utilizable en esa pagina.');
    }

    first.res.destroy();
    throw new LinkError('Ese enlace no es una imagen, un video ni una pagina con vista previa.');
  } catch (e) {
    if (e instanceof LinkError) throw e;
    if (opts.signal.aborted || e?.name === 'AbortError' || e?.name === 'TimeoutError') {
      throw new LinkError('El enlace tardo demasiado en responder.');
    }
    log.warn({ url, err: e?.code || e?.message }, 'No se pudo abrir el enlace');
    throw new LinkError('No pude abrir ese enlace.');
  }
}
