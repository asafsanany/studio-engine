import { pino } from 'pino';

const isProduction = process.env.NODE_ENV === 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  // pino-pretty is a dev dependency: only resolved when not running in production.
  ...(isProduction ? {} : { transport: { target: 'pino-pretty' } }),
});
