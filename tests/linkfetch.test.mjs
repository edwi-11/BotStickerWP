// Pruebas del descargador de enlaces (sin WhatsApp). Ejecutar:  npm test
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import zlib from 'node:zlib';

import {
  extractLinkUrl,
  extractMediaCandidates,
  fetchLinkMedia,
  isPublicAddress,
  LinkError,
} from '../src/linkfetch.js';

// PNG 1x1 valido
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let server;
let other; // segundo servidor, NO incluido en la lista de permitidos
let base;
let allow;

before(async () => {
  other = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(PNG);
  });
  await new Promise((r) => other.listen(0, '127.0.0.1', r));
  const otherPort = other.address().port;

  server = http.createServer((req, res) => {
    const send = (status, type, body, extra = {}) => {
      res.writeHead(status, { 'Content-Type': type, ...extra });
      res.end(body);
    };
    switch (new URL(req.url, 'http://x').pathname) {
      case '/img.png': return send(200, 'image/png', PNG);
      case '/redir': return send(302, 'text/plain', '', { Location: '/img.png' });
      case '/loop': return send(302, 'text/plain', '', { Location: '/loop' });
      case '/to-private': return send(302, 'text/plain', '', { Location: `http://127.0.0.1:${otherPort}/img.png` });
      case '/big': return send(200, 'image/png', Buffer.alloc(3 * 1024 * 1024, 1));
      case '/pdf': return send(200, 'application/pdf', 'x');
      case '/svg': return send(200, 'image/svg+xml', '<svg/>');
      case '/missing': return send(404, 'text/plain', 'no');
      case '/embed': return send(200, 'text/html', '<html>reproductor</html>');
      case '/slow': return; // nunca responde
      case '/page-og':
        return send(200, 'text/html; charset=utf-8',
          '<html><head><meta property="og:image" content="/img.png?a=1&amp;b=2"></head></html>');
      case '/page-video-embed':
        return send(200, 'text/html',
          '<meta property="og:video" content="/embed"><meta property="og:image" content="/img.png">');
      case '/page-empty': return send(200, 'text/html', '<html><body>nada</body></html>');
      case '/page-gzip':
        return send(200, 'text/html',
          zlib.gzipSync('<meta property="og:image" content="/img.png">'), { 'Content-Encoding': 'gzip' });
      default: return send(404, 'text/plain', 'no');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  base = `http://127.0.0.1:${port}`;
  allow = [`127.0.0.1:${port}`];
});

after(() => {
  server.closeAllConnections?.();
  server.close();
  other.close();
});

const run = (urlPath, extra = {}) =>
  fetchLinkMedia(`${base}${urlPath}`, {
    dir: mkdtempSync(path.join(os.tmpdir(), 'lf-')),
    allowHostPorts: allow,
    timeoutMs: 5000,
    ...extra,
  });

// ---------------------------------------------------------------- extractLinkUrl
test('extractLinkUrl: solo acepta mensajes que son un enlace', () => {
  assert.equal(extractLinkUrl('https://ejemplo.com/a.jpg'), 'https://ejemplo.com/a.jpg');
  assert.equal(extractLinkUrl('  http://x.com/y  '), 'http://x.com/y');
  assert.equal(extractLinkUrl('/sticker https://x.com/y'), 'https://x.com/y');
  assert.equal(extractLinkUrl('<https://x.com/y>'), 'https://x.com/y');
  assert.equal(extractLinkUrl('mira esto https://x.com/y'), null);
  assert.equal(extractLinkUrl('hola'), null);
  assert.equal(extractLinkUrl('ftp://x.com/y'), null);
  assert.equal(extractLinkUrl(undefined), null);
});

// ---------------------------------------------------------------- isPublicAddress
test('isPublicAddress: rechaza direcciones privadas/locales y acepta publicas', () => {
  for (const ip of [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '0.0.0.0', '100.64.0.1', '224.0.0.1', '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a00:1', '2002:7f00:1::', 'no-es-ip',
  ]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700:4700::1111']) {
    assert.equal(isPublicAddress(ip), true, ip);
  }
});

// ---------------------------------------------------------------- extractMediaCandidates
test('extractMediaCandidates: video primero, luego imagen, absolutas y sin repetir', () => {
  const html = `
    <meta name="twitter:image" content="/t.png">
    <meta property='og:image' content='https://cdn.x.com/a.jpg?x=1&amp;y=2'>
    <meta content="https://cdn.x.com/v.mp4" property="og:video:secure_url">
    <meta property="og:image" content="https://cdn.x.com/a.jpg?x=1&amp;y=2">
    <meta property="og:image" content="javascript:alert(1)">
    <link rel="image_src" href="/l.png">`;
  assert.deepEqual(extractMediaCandidates(html, 'https://site.com/pagina'), [
    'https://cdn.x.com/v.mp4',
    'https://cdn.x.com/a.jpg?x=1&y=2',
    'https://site.com/t.png',
    'https://site.com/l.png',
  ]);
});

// ---------------------------------------------------------------- descargas
test('enlace directo a imagen', async () => {
  const r = await run('/img.png');
  assert.equal(r.kind, 'image');
  assert.deepEqual(readFileSync(r.filePath), PNG);
});

test('sigue una redireccion', async () => {
  const r = await run('/redir');
  assert.deepEqual(readFileSync(r.filePath), PNG);
});

test('pagina con og:image (URL relativa y &amp;)', async () => {
  const r = await run('/page-og');
  assert.equal(r.kind, 'image');
  assert.match(r.sourceUrl, /\/img\.png\?a=1&b=2$/);
  assert.deepEqual(readFileSync(r.filePath), PNG);
});

test('pagina cuyo og:video es un reproductor HTML: cae a og:image', async () => {
  const r = await run('/page-video-embed');
  assert.equal(r.kind, 'image');
  assert.deepEqual(readFileSync(r.filePath), PNG);
});

test('pagina comprimida con gzip', async () => {
  const r = await run('/page-gzip');
  assert.deepEqual(readFileSync(r.filePath), PNG);
});

test('pagina sin imagen -> LinkError', async () => {
  await assert.rejects(run('/page-empty'), LinkError);
});

test('tipos no soportados -> LinkError', async () => {
  await assert.rejects(run('/pdf'), LinkError);
  await assert.rejects(run('/svg'), LinkError);
});

test('error HTTP -> LinkError', async () => {
  await assert.rejects(run('/missing'), /error \(404\)/);
});

test('demasiadas redirecciones -> LinkError', async () => {
  await assert.rejects(run('/loop'), /demasiadas redirecciones/);
});

test('archivo mas grande que el limite -> LinkError', async () => {
  await assert.rejects(run('/big', { maxBytes: 1024 * 1024 }), /pesa mas de 1 MB/);
});

test('servidor que no responde -> LinkError por tiempo', async () => {
  await assert.rejects(run('/slow', { timeoutMs: 300 }), /tardo demasiado/);
});

// ---------------------------------------------------------------- SSRF
test('SSRF: localhost / IP privada / metadatos en la nube quedan bloqueados', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lf-'));
  for (const url of [
    `${base}/img.png`, // 127.0.0.1 sin estar en la lista de permitidos de pruebas
    'http://localhost/x.png',
    'http://[::1]/x.png',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.5/x.png',
    'http://0.0.0.0/x.png',
    'http://[::ffff:127.0.0.1]/x.png',
    'http://2130706433/x.png', // 127.0.0.1 en decimal
  ]) {
    await assert.rejects(fetchLinkMedia(url, { dir, timeoutMs: 3000 }), LinkError, url);
  }
});

test('SSRF: una redireccion hacia una IP privada tambien se bloquea', async () => {
  await assert.rejects(run('/to-private'), /no esta permitido/);
});

test('SSRF: esquemas, puertos y credenciales no permitidos', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lf-'));
  for (const url of [
    'file:///etc/passwd',
    'ftp://ejemplo.com/x.png',
    'http://ejemplo.com:22/x.png',
    'http://usuario:clave@ejemplo.com/x.png',
    'esto no es una url',
  ]) {
    await assert.rejects(fetchLinkMedia(url, { dir, timeoutMs: 3000 }), LinkError, url);
  }
});
