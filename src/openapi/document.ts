import type { AppConfig } from '../config/index.js';
import type { RegisteredTool, ToolRegistry } from '../tools/registry.js';
import { serverInstructions } from '../tools/guidance.js';

type JsonObject = Record<string, unknown>;

const errorSchema: JsonObject = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message', 'retryable', 'requestId'],
      properties: {
        code: {
          type: 'string',
          enum: [
            'bad_request',
            'unauthorized',
            'forbidden',
            'not_found',
            'limit_exceeded',
            'rate_limited',
            'not_ready',
            'busy',
            'timeout',
            'upstream_error',
            'internal_error',
          ],
        },
        message: { type: 'string' },
        details: {},
        retryable: { type: 'boolean' },
        requestId: { type: 'string' },
      },
    },
  },
};

const errorResponses: JsonObject = Object.fromEntries(
  [
    [400, 'Invalid input'],
    [401, 'Missing or invalid credentials'],
    [403, 'Path outside the workspace root or unreadable'],
    [404, 'Unknown tool or missing file'],
    [413, 'A deployment limit was exceeded'],
    [429, 'Rate limited'],
    [500, 'Tool server failure'],
    [503, 'Not ready or analysis capacity saturated'],
    [504, 'Analysis deadline exceeded'],
  ].map(([status, description]) => [
    String(status),
    {
      description,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    },
  ]),
);

const toolPath = (tool: RegisteredTool): JsonObject => ({
  post: {
    operationId: tool.name,
    summary: tool.summary,
    description: tool.description,
    tags: ['read'],
    'x-openai-isConsequential': false,
    requestBody: {
      required: true,
      content: { 'application/json': { schema: tool.inputJsonSchema } },
    },
    responses: {
      '200': {
        description: 'Tool result',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['tool', 'requestId', 'result'],
              properties: {
                tool: { type: 'string' },
                requestId: { type: 'string' },
                result: tool.outputJsonSchema,
              },
            },
          },
        },
      },
      ...errorResponses,
    },
  },
});

export const buildOpenApiDocument = (config: AppConfig, registry: ToolRegistry): JsonObject => {
  const paths: JsonObject = {
    '/health': {
      get: {
        operationId: 'health',
        summary: 'Liveness probe.',
        description: 'Reports that the process is running. It does not imply the server is usable.',
        security: [],
        responses: { '200': { description: 'Process is alive' } },
      },
    },
    '/ready': {
      get: {
        operationId: 'ready',
        summary: 'Readiness probe.',
        description:
          'Verifies configuration, a canonical readable workspace root, and analysis capacity without reading or listing source.',
        security: [],
        responses: {
          '200': { description: 'Ready to serve analysis' },
          '503': { description: 'Not ready' },
        },
      },
    },
    '/version': {
      get: {
        operationId: 'version',
        summary: 'Build and capability information.',
        security: [],
        responses: { '200': { description: 'Service metadata' } },
      },
    },
    '/openapi.json': {
      get: {
        operationId: 'openapi',
        summary: 'Generated OpenAPI document.',
        security: [],
        responses: { '200': { description: 'OpenAPI 3.1 document' } },
      },
    },
    '/tools': {
      get: {
        operationId: 'listTools',
        summary: 'List every registered tool and JSON Schema.',
        responses: { '200': { description: 'Tool catalogue' }, ...errorResponses },
      },
    },
    '/mcp': {
      post: {
        operationId: 'mcp',
        summary: 'Stateless Streamable HTTP MCP endpoint.',
        responses: { '200': { description: 'MCP response' }, ...errorResponses },
      },
    },
  };
  for (const tool of registry.list()) paths[`/tools/${tool.name}`] = toolPath(tool);

  return {
    openapi: '3.1.0',
    info: {
      title: 'Agent Tool Server AST Summarizer',
      version: config.service.version,
      description: `Read-only TypeScript and JavaScript declaration and dependency analysis for one local workspace.\n\n${serverInstructions}`,
    },
    servers: [{ url: config.service.publicBaseUrl ?? `http://localhost:${config.http.port}` }],
    security: config.auth.mode === 'disabled' ? [] : [{ bearerAuth: [] }],
    components: {
      schemas: { Error: errorSchema },
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Static API key supplied as a bearer token or x-api-key header.',
        },
      },
    },
    paths,
    tags: [{ name: 'read', description: 'Read-only analysis tools.' }],
  };
};
