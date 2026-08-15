import pino, { type Logger } from 'pino';
import type { AppConfig } from '../config/index.js';
import type { MeasurementSink } from '../platform/measurements.js';

export const createLogger = (config: AppConfig): Logger =>
  pino({
    level: config.logLevel,
    base: {
      service: config.service.name,
      version: config.service.version,
      environment: config.env,
    },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.x-api-key',
        'headers.authorization',
        'headers.x-api-key',
      ],
      censor: '[REDACTED]',
    },
  });

/**
 * Emits measurement events as structured logs.
 *
 * Only the safe fields defined by MeasurementEvent are forwarded, so no path, filename, source
 * text, tool argument, result, or credential can reach the log.
 */
export const loggingMeasurementSink = (logger: Logger): MeasurementSink => ({
  record: (event) => logger.info({ ...event, event: event.name }),
});
