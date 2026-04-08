import pino from 'pino';
import { config } from './config';

function shouldIgnoreBaileysNoise(args: Parameters<pino.LogFn>): boolean {
  const [firstArg, secondArg] = args;
  const msg = typeof firstArg === 'string'
    ? firstArg
    : typeof secondArg === 'string'
      ? secondArg
      : '';
  const meta = typeof firstArg === 'object' && firstArg !== null ? firstArg as Record<string, unknown> : {};
  const err = meta.err as Record<string, unknown> | undefined;
  const key = meta.key as Record<string, unknown> | undefined;
  const remoteJid = typeof key?.remoteJid === 'string' ? key.remoteJid : '';
  const errName = typeof err?.name === 'string' ? err.name : '';
  const errMessage = typeof err?.message === 'string' ? err.message : '';

  return msg.includes('failed to decrypt message')
    && (
      (errName === 'SessionError' && errMessage === 'No session record')
      || (errName === 'PreKeyError' && errMessage === 'Invalid PreKey ID')
    )
    && remoteJid.endsWith('@lid');
}

export const logger = pino({
  level: config.nodeEnv === 'production' ? 'info' : 'info',
  transport:
    config.nodeEnv !== 'production'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            ignore: 'pid,hostname',
            translateTime: 'HH:MM:ss',
            messageFormat: '{msg}',
          },
        }
      : undefined,
});

/** Baileys 专用 logger：只输出 warn 及以上，压制海量 debug/info 噪音 */
export const baileysLogger = pino({
  level: 'warn',
  hooks: {
    logMethod(args, method) {
      if (shouldIgnoreBaileysNoise(args)) return;
      method.apply(this, args);
    },
  },
  transport:
    config.nodeEnv !== 'production'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            ignore: 'pid,hostname',
            translateTime: 'HH:MM:ss',
            messageFormat: '[baileys] {msg}',
          },
        }
      : undefined,
});
