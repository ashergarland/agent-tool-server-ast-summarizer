import type { AppConfig } from '../config/index.js';
import { AppError, toAppError } from '../errors.js';
import type { HttpServer } from './types.js';

export const registerErrorHandler = (app: HttpServer, config: AppConfig): void => {
  app.setErrorHandler((error, request, reply) => {
    const appError = toAppError(error);
    const safe =
      config.isProduction && appError.statusCode >= 500
        ? new AppError(
            appError.code,
            'The tool server failed to complete the request',
            undefined,
            appError.retryable,
          )
        : appError;

    if (appError.statusCode >= 500) {
      request.log.error(
        { err: error, event: 'request.error', errorCode: appError.code },
        'unhandled request failure',
      );
    }

    void reply.status(appError.statusCode).send({ error: safe.toPayload(String(request.id)) });
  });
};
