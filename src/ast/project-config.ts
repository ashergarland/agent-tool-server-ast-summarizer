import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import type { WarningCollector } from '../platform/warnings.js';
import type { Workspace } from '../platform/workspace.js';

/**
 * Bounded tsconfig handling.
 *
 * Only module-resolution options are read. The include/exclude file set is never expanded, so one
 * dependency query can never pull an entire project into memory, and configuration files outside
 * the workspace root are refused.
 */

const maxExtendsDepth = 8;
const maxConfigBytes = 512 * 1024;

/** The subset of compiler options that can change how a specifier resolves. */
const resolutionOptionNames = new Set([
  'allowJs',
  'baseUrl',
  'customConditions',
  'jsx',
  'module',
  'moduleResolution',
  'moduleSuffixes',
  'paths',
  'resolveJsonModule',
  'rootDir',
  'rootDirs',
  'target',
]);

export const defaultResolutionOptions: ts.CompilerOptions = {
  allowJs: true,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.Latest,
};

export interface ProjectConfiguration {
  readonly options: ts.CompilerOptions;
  /** Root-relative path of the configuration file that was used, when one was found. */
  readonly configPath: string | undefined;
}

const readJsonConfig = (path: string): Record<string, unknown> | undefined => {
  const stats = ts.sys.getFileSize?.(path);
  if (stats !== undefined && stats > maxConfigBytes) return undefined;
  const text = ts.sys.readFile(path);
  if (text === undefined) return undefined;
  const parsed = ts.parseConfigFileTextToJson(path, text);
  if (parsed.error || typeof parsed.config !== 'object' || parsed.config === null) return undefined;
  return parsed.config as Record<string, unknown>;
};

/** Walks from the entry directory to the workspace root looking for a tsconfig or jsconfig. */
const findConfigFile = (root: string, startDirectory: string): string | undefined => {
  let current = startDirectory;
  for (let depth = 0; depth <= 64; depth += 1) {
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
      const candidate = join(current, name);
      if (ts.sys.fileExists(candidate)) return candidate;
    }
    if (current === root) return undefined;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
};

const resolutionSubset = (compilerOptions: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(compilerOptions).filter(([name]) => resolutionOptionNames.has(name)),
  );

/**
 * Resolves the effective resolution options for one entry file. Extends chains are followed only
 * while they stay inside the workspace root and within a small depth bound.
 */
export const loadProjectConfiguration = (
  workspace: Workspace,
  root: string,
  entryRealPath: string,
  warnings: WarningCollector,
): ProjectConfiguration => {
  const configPath = findConfigFile(root, dirname(entryRealPath));
  if (!configPath) return { options: { ...defaultResolutionOptions }, configPath: undefined };

  const merged: ts.CompilerOptions = {};
  let hadInvalidOptions = false;
  let current: string | undefined = configPath;
  const seen = new Set<string>();
  for (let depth = 0; current !== undefined && depth < maxExtendsDepth; depth += 1) {
    if (seen.has(current)) {
      warnings.add('tsconfig_extends_cycle', 'The configuration extends chain contains a cycle');
      break;
    }
    seen.add(current);
    if (!workspace.isWithin(root, current)) {
      warnings.add(
        'tsconfig_outside_root',
        'A referenced configuration file lies outside the workspace root and was ignored',
      );
      break;
    }
    const config: Record<string, unknown> | undefined = readJsonConfig(current);
    if (!config) {
      warnings.add('tsconfig_unreadable', 'A configuration file could not be parsed');
      break;
    }
    // Relative paths inside a configuration resolve against that file, not against the nearest one.
    const converted = ts.convertCompilerOptionsFromJson(
      resolutionSubset((config.compilerOptions ?? {}) as Record<string, unknown>),
      dirname(current),
      current,
    );
    hadInvalidOptions ||= converted.errors.length > 0;
    // Nearer configurations win, so only fill values the chain has not provided yet.
    for (const [name, value] of Object.entries(converted.options)) {
      if (name === 'configFilePath') continue;
      if (!(name in merged)) (merged as Record<string, unknown>)[name] = value;
    }
    const extendsValue = config.extends;
    if (typeof extendsValue !== 'string' || !extendsValue.startsWith('.')) {
      if (typeof extendsValue === 'string') {
        warnings.add(
          'tsconfig_extends_package',
          'A configuration extends a package and only local resolution options were applied',
        );
      }
      break;
    }
    const next = resolve(dirname(current), extendsValue);
    current = ts.sys.fileExists(next)
      ? next
      : ts.sys.fileExists(`${next}.json`)
        ? `${next}.json`
        : undefined;
  }

  if (hadInvalidOptions) {
    warnings.add(
      'tsconfig_options_ignored',
      'Some configuration options were invalid and default resolution was used for them',
    );
  }
  const options: ts.CompilerOptions = { ...defaultResolutionOptions, ...merged };
  if (options.baseUrl !== undefined) {
    const baseUrl = resolve(options.baseUrl);
    if (baseUrl !== root && !workspace.isWithin(root, baseUrl)) {
      warnings.add(
        'tsconfig_base_url_outside_root',
        'The configured baseUrl lies outside the workspace root and was ignored',
      );
      delete options.baseUrl;
      delete options.paths;
    }
  }
  return { options, configPath: workspace.formatRelative(root, configPath) };
};
