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

export class StdioMcpClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, (response: JsonRpcResponse) => void>();

  public readonly stderr: string[] = [];
  /** Anything received on stdout that was not a JSON-RPC message. */
  public readonly nonProtocolOutput: string[] = [];

  public constructor(cwd: string, env: NodeJS.ProcessEnv = {}) {
    this.child = spawn(process.execPath, [tsxCli, stdioEntry], {
      cwd,
      env: {
        ...process.env,
        // Cleared so the entry point exercises its documented default of the launch directory.
        AST_WORKSPACE_ROOT: '',
        TSX_TSCONFIG_PATH: `${repositoryRoot}tsconfig.json`,
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.consume(chunk));
    this.child.stderr.on('data', (chunk: string) => this.stderr.push(chunk));
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

  public async close(): Promise<void> {
    this.child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill('SIGKILL');
        resolve();
      }, 5_000);
      timer.unref?.();
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
