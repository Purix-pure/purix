// src/platform/logger.ts

export const logger = {
  log: (...args: any[]) => console.error(...args), // Route log to stderr
  error: (...args: any[]) => console.error(...args),
  warn: (...args: any[]) => console.warn(...args),
  info: (...args: any[]) => console.info(...args),
};
