export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'limit_exceeded'
  | 'rate_limited'
  | 'not_ready'
  | 'busy'
  | 'timeout'
  | 'upstream_error'
  | 'internal_error';

const statusByCode: Readonly<Record<ErrorCode, number>> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  limit_exceeded: 413,
  rate_limited: 429,
  not_ready: 503,
  busy: 503,
  timeout: 504,
  upstream_error: 502,
  internal_error: 500,
};

const retryableByCode: Readonly<Record<ErrorCode, boolean>> = {
  bad_request: false,
  unauthorized: false,
  forbidden: false,
  not_found: false,
  limit_exceeded: false,
  rate_limited: true,
  not_ready: true,
  busy: true,
  timeout: true,
  upstream_error: true,
  internal_error: false,
};

const maximumMessageLength = 300;
const maximumDetailEntries = 24;

/** Bounds a caller-visible message so no transport emits unbounded text. */
export const boundedMessage = (message: string): string =>
  message.length <= maximumMessageLength ? message : `${message.slice(0, maximumMessageLength)}...`;

const boundedDetails = (details: unknown): unknown => {
  if (details === undefined || details === null) return undefined;
  if (Array.isArray(details)) return details.slice(0, maximumDetailEntries);
  if (typeof details === 'object') {
    return Object.fromEntries(Object.entries(details).slice(0, maximumDetailEntries));
  }
  return details;
};

export class AppError extends Error {
  public override readonly name = 'AppError';
  public readonly statusCode: number;
  public readonly retryable: boolean;
  public readonly details: unknown;

  public constructor(
    public readonly code: ErrorCode,
    message: string,
    details?: unknown,
    retryable?: boolean,
    cause?: unknown,
  ) {
    super(boundedMessage(message), { cause });
    this.statusCode = statusByCode[code];
    this.retryable = retryable ?? retryableByCode[code];
    this.details = boundedDetails(details);
  }

  /** The transport-safe projection; it never carries a stack, cause, or absolute path. */
  public toPayload(requestId: string): {
    readonly code: ErrorCode;
    readonly message: string;
    readonly retryable: boolean;
    readonly requestId: string;
    readonly details?: unknown;
  } {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      requestId,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export const badRequest = (message: string, details?: unknown): AppError =>
  new AppError('bad_request', message, details);
export const unauthorized = (message: string): AppError => new AppError('unauthorized', message);
export const forbidden = (message: string, details?: unknown): AppError =>
  new AppError('forbidden', message, details);
export const notFound = (message: string, details?: unknown): AppError =>
  new AppError('not_found', message, details);
export const limitExceeded = (message: string, details?: unknown): AppError =>
  new AppError('limit_exceeded', message, details);
export const notReady = (message: string, details?: unknown): AppError =>
  new AppError('not_ready', message, details);
export const serverBusy = (message: string, details?: unknown): AppError =>
  new AppError('busy', message, details);
export const timedOut = (message: string, details?: unknown): AppError =>
  new AppError('timeout', message, details);

export const toAppError = (error: unknown): AppError =>
  error instanceof AppError
    ? error
    : new AppError(
        'internal_error',
        'The tool server failed to complete the request',
        undefined,
        false,
        error,
      );
