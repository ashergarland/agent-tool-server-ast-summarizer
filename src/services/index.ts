import type { AppConfig } from '../config/index.js';
import { AstService } from './ast.js';
import { Guardrails } from './guardrails.js';

export interface Services {
  readonly ast: AstService;
  readonly guardrails: Guardrails;
}

export const createServices = (
  config: AppConfig,
  workspaceRoot: string = process.cwd(),
): Services => {
  const guardrails = new Guardrails(config);
  return { ast: new AstService(workspaceRoot), guardrails };
};
