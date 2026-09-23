export function menuText() {
  return [
    '🤖 BOT DE STICKERS',
    '',
    'Envía una imagen o video y lo convertiré automáticamente en un sticker de WhatsApp.',
    '',
    'Comandos:',
    '/menu - Mostrar este menú',
    '/status - Ver el estado de la conexión del bot',
  ].join('\n');
}

export function statusText({ connState, startedAt }) {
  const upSeconds = Math.floor((Date.now() - startedAt) / 1000);
  const min = Math.floor(upSeconds / 60);
  const sec = upSeconds % 60;
  const estados = {
    connected: '✅ conectado',
    connecting: '🔄 conectando...',
    qr: '📷 esperando escaneo de QR',
    pairing: '🔑 esperando código de vinculación',
    disconnected: '❌ desconectado (reintentando)',
    logged_out: '❌ sesión cerrada, hay que volver a vincular',
    starting: '🔄 iniciando...',
  };
  return [
    '📊 ESTADO DEL BOT',
    '',
    `WhatsApp: ${estados[connState] || connState}`,
    `Tiempo activo: ${min} min ${sec}s`,
  ].join('\n');
}
