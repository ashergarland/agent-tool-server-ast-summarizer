import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * A deliberately dependency-free stdio MCP client.
 *
 * Speaking newline-delimited JSON-RPC directly is what makes this an honest end-to-end test: it
 * proves the real `src/mcp/stdio.ts` process serves the protocol and that nothing else is written
 * to stdout. Using the SDK client here would hide a stray `console.log` behind the SDK's parser.
 */

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const tsxCli = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url));
const stdioEntry = fileURLToPath(new URL('../../src/mcp/stdio.ts', import.meta.url));

interface JsonRpcResponse {
  readonly id?: number;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code: number; readonly message: string };
}

export interface StdioExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export class StdioMcpClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, (response: JsonRpcResponse) => void>();

  public readonly stderr: string[] = [];
  /** Anything received on stdout that was not a JSON-RPC message. */
  public readonly nonProtocolOutput: string[] = [];
  /** Resolves with how the entry point terminated, so graceful shutdown can be asserted. */
  public readonly exit: Promise<StdioExit>;

  public constructor(cwd: string, env: NodeJS.ProcessEnv = {}) {
    const baseEnv: NodeJS.ProcessEnv = {
      ...process.env,
      TSX_TSCONFIG_PATH: `${repositoryRoot}tsconfig.json`,
    };
    // Removed rather than blanked so callers can distinguish "unset" from "blank"; an inherited
    // value would otherwise silently satisfy the default the tests exist to exercise.
    delete baseEnv['AST_WORKSPACE_ROOT'];

    this.child = spawn(process.execPath, [tsxCli, stdioEntry], {
      cwd,
      env: { ...baseEnv, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.consume(chunk));
    this.child.stderr.on('data', (chunk: string) => this.stderr.push(chunk));
    this.exit = new Promise<StdioExit>((resolve) => {
      this.child.once('exit', (code, signal) => resolve({ code, signal }));
    });
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > 0) this.dispatch(line);
      index = this.buffer.indexOf('\n');
    }
  }

  private dispatch(line: string): void {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      this.nonProtocolOutput.push(line);
      return;
    }
    if (typeof message.id !== 'number') return;
    const resolve = this.pending.get(message.id);
    if (!resolve) return;
    this.pending.delete(message.id);
    resolve(message);
  }

  private send(payload: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  public request(method: string, params: Record<string, unknown> = {}): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`stdio MCP request timed out: ${method}\n${this.stderr.join('')}`));
      }, 45_000);
      timer.unref?.();
      this.pending.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  public notify(method: string, params: Record<string, unknown> = {}): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  public async initialize(): Promise<JsonRpcResponse> {
    const response = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'ast-stdio-test', version: '1.0.0' },
    });
    this.notify('notifications/initialized');
    return response;
  }

  /**
   * Closes the client end of the pipe — how an MCP client asks a stdio server to stop — and reports
   * how the entry point terminated, so a clean exit can be asserted rather than assumed.
   */
  public async shutdown(timeoutMs = 15_000): Promise<StdioExit> {
    this.child.stdin.end();
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.child.kill('SIGKILL');
        reject(new Error(`stdio entry point did not exit within ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([this.exit, expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  public async close(): Promise<void> {
    await this.shutdown(5_000).catch(() => undefined);
  }
}
