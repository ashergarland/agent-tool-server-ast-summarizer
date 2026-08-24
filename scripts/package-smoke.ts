import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
  type SpawnSyncOptionsWithStringEncoding,
} from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const packageName = '@agent-tool-platform/ast-summarizer';
const binName = 'agent-tool-ast-summarizer';
const expectedTools = ['get_dependency_graph', 'get_file_skeleton'];
const npmCli = process.env['npm_execpath'];

interface NpmPackFile {
  readonly path: string;
}

interface NpmPackResult {
  readonly name: string;
  readonly version: string;
  readonly filename: string;
  readonly size: number;
  readonly unpackedSize: number;
  readonly files: NpmPackFile[];
}

interface JsonRpcResponse extends Record<string, unknown> {
  readonly id?: number;
  readonly result?: Record<string, unknown>;
  readonly error?: unknown;
}

interface PendingRequest {
  readonly reject: (error: Error) => void;
  readonly resolve: (response: JsonRpcResponse) => void;
  readonly timer: NodeJS.Timeout;
}

interface StdioExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

type RunOptions = Omit<SpawnSyncOptionsWithStringEncoding, 'encoding'>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isNpmPackResult = (value: unknown): value is NpmPackResult =>
  isRecord(value) &&
  typeof value['name'] === 'string' &&
  typeof value['version'] === 'string' &&
  typeof value['filename'] === 'string' &&
  typeof value['size'] === 'number' &&
  typeof value['unpackedSize'] === 'number' &&
  Array.isArray(value['files']) &&
  value['files'].every((file) => isRecord(file) && typeof file['path'] === 'string');

const runNode = (arguments_: string[], options: RunOptions = {}): string => {
  const result = spawnSync(process.execPath, arguments_, {
    cwd: repositoryRoot,
    env: { ...process.env, npm_config_update_notifier: 'false' },
    ...options,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Command failed (${process.execPath} ${arguments_.join(' ')}):\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout;
};

const runNpm = (arguments_: string[], options: RunOptions = {}): string => {
  assert(npmCli, 'package:smoke must run through npm so the active npm CLI can be reused');
  return runNode([npmCli, ...arguments_], options);
};

const nullTerminatedString = (buffer: Buffer, start: number, length: number): string => {
  const field = buffer.subarray(start, start + length);
  const end = field.indexOf(0);
  return field
    .subarray(0, end < 0 ? field.length : end)
    .toString('utf8')
    .trim();
};

const tarFileNames = (tarball: Buffer): string[] => {
  const archive = gunzipSync(tarball);
  const names: string[] = [];
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const name = nullTerminatedString(header, 0, 100);
    const prefix = nullTerminatedString(header, 345, 155);
    const sizeField = nullTerminatedString(header, 124, 12);
    const size = Number.parseInt(sizeField || '0', 8);
    assert(Number.isSafeInteger(size) && size >= 0, `Invalid tar entry size for ${name}`);

    const type = String.fromCharCode(header[156] ?? 0);
    if (type === '\0' || type === '0') names.push(prefix ? `${prefix}/${name}` : name);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
};

const assertPackageContents = (packResult: NpmPackResult, tarballBuffer: Buffer): string[] => {
  const tarFiles = tarFileNames(tarballBuffer)
    .map((path) => {
      assert(path.startsWith('package/'), `Unexpected tar entry outside package/: ${path}`);
      return path.slice('package/'.length);
    })
    .sort();
  const reportedFiles = packResult.files.map((file) => file.path).sort();
  assert(
    JSON.stringify(tarFiles) === JSON.stringify(reportedFiles),
    'The npm pack manifest does not match the files in the actual tarball',
  );

  const required = [
    'LICENSE',
    'README.md',
    'dist/index.js',
    'dist/mcp/stdio.js',
    'dist/public.d.ts',
    'dist/public.js',
    'package.json',
  ];
  for (const path of required) {
    assert(tarFiles.includes(path), `Packed package is missing ${path}`);
  }

  const forbidden = [
    '.env',
    '.github/',
    '.vscode/',
    'coverage/',
    'examples/',
    'infra/',
    'scripts/',
    'src/',
    'tests/',
    'Dockerfile',
    'openapi.json',
    'server.json',
    'tsconfig.json',
    'vitest.config.ts',
  ];
  for (const path of tarFiles) {
    const match = forbidden.find(
      (candidate) => path === candidate || (candidate.endsWith('/') && path.startsWith(candidate)),
    );
    assert(!match, `Forbidden development file was packed: ${path}`);
  }
  return tarFiles;
};

class StdioMcpClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  public readonly nonProtocolOutput: string[] = [];
  public stderr = '';
  public closed = false;
  public readonly exit: Promise<StdioExit>;

  public constructor(command: string, cwd: string) {
    const env = { ...process.env };
    delete env['AST_WORKSPACE_ROOT'];
    delete env['NODE_PATH'];
    delete env['TSX_TSCONFIG_PATH'];

    this.child = spawn(command, [], {
      cwd,
      env,
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.consume(chunk));
    this.child.stderr.on('data', (chunk: string) => {
      this.stderr += chunk;
    });
    this.exit = new Promise<StdioExit>((resolveExit, rejectExit) => {
      this.child.once('error', (error) => {
        this.rejectPending(error);
        rejectExit(error);
      });
      this.child.once('exit', (code, signal) => {
        this.flush();
        if (this.pending.size > 0) {
          this.rejectPending(
            new Error(`stdio executable exited before responding (code=${code}, signal=${signal})`),
          );
        }
        resolveExit({ code, signal });
      });
    });
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.dispatch(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  private flush(): void {
    const line = this.buffer.trim();
    this.buffer = '';
    if (line) this.dispatch(line);
  }

  private dispatch(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.nonProtocolOutput.push(line);
      return;
    }
    if (!isRecord(parsed) || parsed['jsonrpc'] !== '2.0') {
      this.nonProtocolOutput.push(line);
      return;
    }
    const id = parsed['id'];
    if (typeof id !== 'number') return;
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.resolve(parsed);
  }

  private send(payload: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  public request(method: string, params: Record<string, unknown> = {}): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    return new Promise<JsonRpcResponse>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`stdio MCP request timed out: ${method}\n${this.stderr}`));
      }, 45_000);
      timer.unref?.();
      this.pending.set(id, { reject: rejectRequest, resolve: resolveRequest, timer });
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
      clientInfo: { name: 'ast-package-smoke', version: '1.0.0' },
    });
    assert(!response.error, `MCP initialize failed: ${JSON.stringify(response.error)}`);
    this.notify('notifications/initialized');
    return response;
  }

  public async shutdown(): Promise<StdioExit> {
    this.child.stdin.end();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, rejectTimeout) => {
      timer = setTimeout(() => {
        this.child.kill();
        rejectTimeout(new Error('Installed stdio executable did not exit within 15 seconds'));
      }, 15_000);
      timer.unref?.();
    });
    try {
      const exit = await Promise.race([this.exit, timeout]);
      this.closed = true;
      return exit;
    } finally {
      clearTimeout(timer);
    }
  }

  public async terminate(): Promise<void> {
    if (this.closed) return;
    this.child.stdin.destroy();
    this.child.kill();
    await this.exit;
    this.closed = true;
  }
}

const main = async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'ast-summarizer-package-smoke-'));
  let client: StdioMcpClient | undefined;
  try {
    assert(
      relative(repositoryRoot, temporaryRoot).startsWith(`..${sep}`),
      'The external consumer must be outside the source checkout',
    );

    runNpm(['run', 'build']);
    const packDirectory = join(temporaryRoot, 'pack');
    await mkdir(packDirectory);
    const packOutput = runNpm([
      'pack',
      '--ignore-scripts',
      '--json',
      '--pack-destination',
      packDirectory,
    ]);
    const packResults: unknown = JSON.parse(packOutput);
    assert(
      Array.isArray(packResults) && packResults.length === 1,
      'npm pack returned no candidate',
    );
    const packResult: unknown = packResults[0];
    assert(isNpmPackResult(packResult), 'npm pack returned malformed package metadata');
    assert(
      packResult.name === packageName,
      `npm pack selected unexpected package ${packResult.name}`,
    );

    const tarballPath = join(packDirectory, packResult.filename);
    const tarballBuffer = await readFile(tarballPath);
    const packedFiles = assertPackageContents(packResult, tarballBuffer);

    const consumerDirectory = join(temporaryRoot, 'consumer');
    await mkdir(consumerDirectory);
    await writeFile(
      join(consumerDirectory, 'package.json'),
      `${JSON.stringify({ name: 'ast-package-smoke-consumer', private: true, type: 'module' }, null, 2)}\n`,
    );
    runNpm(
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--package-lock=false',
        tarballPath,
        '@types/node@22.20.1',
      ],
      { cwd: consumerDirectory },
    );

    const installedPackage = join(
      consumerDirectory,
      'node_modules',
      '@agent-tool-platform',
      'ast-summarizer',
    );
    const installedManifest: unknown = JSON.parse(
      await readFile(join(installedPackage, 'package.json'), 'utf8'),
    );
    assert(isRecord(installedManifest), 'Installed package manifest is not an object');
    assert(
      installedManifest['name'] === packageName,
      'External consumer installed the wrong package',
    );
    assert(
      installedManifest['version'] === packResult.version,
      'Installed package version differs from the packed candidate',
    );
    const installedBin = installedManifest['bin'];
    assert(
      isRecord(installedBin) && installedBin[binName] === 'dist/mcp/stdio.js',
      'Installed package has an unexpected stdio bin target',
    );

    const consumerSource = `
import {
  astManifest,
  astSummarizerCapability,
  type GetDependencyGraphInput,
  type GetDependencyGraphOutput,
  type GetFileSkeletonInput,
  type GetFileSkeletonOutput,
} from '${packageName}';

const skeletonInput: GetFileSkeletonInput = { path: 'src/main.ts' };
const graphInput: GetDependencyGraphInput = { path: 'src/main.ts', maxDepth: 2 };
const useSkeleton = (result: GetFileSkeletonOutput): string => result.skeleton;
const useGraph = (result: GetDependencyGraphOutput): readonly string[] => result.files;

void [astManifest, astSummarizerCapability, skeletonInput, graphInput, useSkeleton, useGraph];
`;
    await writeFile(join(consumerDirectory, 'consumer.ts'), consumerSource.trimStart());
    await writeFile(
      join(consumerDirectory, 'tsconfig.json'),
      `${JSON.stringify(
        {
          compilerOptions: {
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            noEmit: true,
            strict: true,
            target: 'ES2022',
          },
          include: ['consumer.ts'],
        },
        null,
        2,
      )}\n`,
    );
    const typescriptCli = join(consumerDirectory, 'node_modules', 'typescript', 'bin', 'tsc');
    await access(typescriptCli, fsConstants.R_OK);
    runNode([typescriptCli, '--project', 'tsconfig.json'], { cwd: consumerDirectory });

    await writeFile(
      join(consumerDirectory, 'consumer.mjs'),
      `import { astManifest, astSummarizerCapability } from '${packageName}';\n` +
        `if (astSummarizerCapability.manifest !== astManifest) throw new Error('Public exports do not compose');\n`,
    );
    runNode(['consumer.mjs'], { cwd: consumerDirectory });

    const installedEntry = join(installedPackage, 'dist', 'mcp', 'stdio.js');
    await access(installedEntry, fsConstants.R_OK);
    const binPath = join(
      consumerDirectory,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? `${binName}.cmd` : binName,
    );
    await access(binPath, fsConstants.R_OK);
    if (process.platform !== 'win32') {
      const binStats = await stat(binPath);
      assert((binStats.mode & 0o111) !== 0, 'Installed stdio executable is not executable');
      assert(
        (await realpath(binPath)) === (await realpath(installedEntry)),
        'npm bin resolves elsewhere',
      );
    }

    const fixtureDirectory = join(temporaryRoot, 'fixture');
    await mkdir(join(fixtureDirectory, 'src'), { recursive: true });
    await writeFile(
      join(fixtureDirectory, 'src', 'types.ts'),
      'export interface User { id: string }\n',
    );
    await writeFile(
      join(fixtureDirectory, 'src', 'main.ts'),
      "import type { User } from './types.js';\n" +
        'export function createUser(id: string): User { return { id }; }\n',
    );

    client = new StdioMcpClient(binPath, fixtureDirectory);
    const initialized = await client.initialize();
    assert(
      initialized.result?.serverInfo,
      'Installed stdio executable returned no MCP server info',
    );

    const listed = await client.request('tools/list');
    assert(!listed.error, `tools/list failed: ${JSON.stringify(listed.error)}`);
    const tools = listed.result?.['tools'];
    assert(Array.isArray(tools), 'tools/list returned no tool array');
    const toolNames = tools
      .map((tool) => {
        assert(
          isRecord(tool) && typeof tool['name'] === 'string',
          'tools/list returned a bad tool',
        );
        return tool['name'];
      })
      .sort();
    assert(
      JSON.stringify(toolNames) === JSON.stringify(expectedTools),
      `Installed package exposed unexpected tools: ${toolNames.join(', ')}`,
    );

    const skeleton = await client.request('tools/call', {
      name: 'get_file_skeleton',
      arguments: { path: 'src/main.ts' },
    });
    const skeletonResult = skeleton.result?.['structuredContent'];
    assert(!skeleton.error && skeleton.result?.['isError'] !== true, 'get_file_skeleton failed');
    assert(isRecord(skeletonResult), 'get_file_skeleton returned no structured content');
    const skeletonText = skeletonResult['skeleton'];
    assert(
      typeof skeletonText === 'string' &&
        skeletonText.includes('export function createUser(id: string): User;'),
      'get_file_skeleton returned no declaration signature',
    );
    assert(
      !skeletonText.includes('return { id }'),
      'get_file_skeleton leaked an implementation body',
    );

    const graph = await client.request('tools/call', {
      name: 'get_dependency_graph',
      arguments: { path: 'src/main.ts', maxDepth: 2 },
    });
    const graphResult = graph.result?.['structuredContent'];
    assert(!graph.error && graph.result?.['isError'] !== true, 'get_dependency_graph failed');
    assert(isRecord(graphResult), 'get_dependency_graph returned no structured content');
    const graphFiles = graphResult['files'];
    assert(
      Array.isArray(graphFiles) && graphFiles.includes('src/types.ts'),
      'Dependency graph missed src/types.ts',
    );

    const exit = await client.shutdown();
    assert(exit.code === 0, `Installed stdio executable exited with code ${exit.code}`);
    assert(
      client.nonProtocolOutput.length === 0,
      `Non-protocol stdout detected: ${client.nonProtocolOutput.join('\n')}`,
    );
    assert(client.stderr === '', `Installed stdio executable wrote to stderr:\n${client.stderr}`);

    process.stdout.write(
      `Package smoke passed for ${packResult.name}@${packResult.version}: ` +
        `${packedFiles.length} files, ${packResult.size} packed bytes, ` +
        `${packResult.unpackedSize} unpacked bytes.\n`,
    );
  } finally {
    if (client && !client.closed) await client.terminate();
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3 });
  }
};

await main();
