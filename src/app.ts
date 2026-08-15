import type { Logger } from 'pino';
import { loadConfig, type AppConfig } from './config/index.js';
import type { MeasurementSink } from './platform/measurements.js';
import { createServices, type Services } from './services/index.js';
import { createHttpServer } from './server/http.js';
import type { HttpServer } from './server/types.js';
import { createToolRegistry, type ToolRegistry } from './tools/registry.js';
import { createLogger, loggingMeasurementSink } from './util/logger.js';

export interface Application {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly services: Services;
  readonly registry: ToolRegistry;
  readonly http: HttpServer;
  shutdown(): Promise<void>;
}

export interface CreateApplicationOptions {
  readonly config?: AppConfig;
  readonly logger?: Logger;
  readonly workspaceRoot?: string;
  readonly measurements?: MeasurementSink;
}

export const createApplication = (options: CreateApplicationOptions = {}): Application => {
  const config = options.config ?? loadConfig();
  const logger = options.logger ?? createLogger(config);
  const services = createServices(config, {
    ...(options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot }),
    measurements: options.measurements ?? loggingMeasurementSink(logger),
  });
  const registry = createToolRegistry();
  const http = createHttpServer({ config, logger, services, registry });
  return {
    config,
    logger,
    services,
    registry,
    http,
    /** Stops accepting work, drains in-flight analysis, then closes the listener. */
    async shutdown(): Promise<void> {
      await services.shutdown();
      await http.close();
    },
  };
};
