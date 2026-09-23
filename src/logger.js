import pino from 'pino';

export const log = pino({ level: process.env.LOG_LEVEL || 'info' });

// Logger "silencioso" para pasarle a Baileys (su propio logging es muy verboso).
export const silentLog = pino({ level: 'silent' });

// Logger para Baileys: solo warn/error, para que se vean fallos de cifrado/sesion
// ("Bad MAC", "No session record", ...). Sube el detalle con BAILEYS_LOG_LEVEL=debug.
export const baileysLog = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'warn' });
