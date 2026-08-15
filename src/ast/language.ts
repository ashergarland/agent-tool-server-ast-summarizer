import ts from 'typescript';
import { extensionOf } from '../platform/workspace.js';

export const supportedExtensions: ReadonlySet<string> = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);

const javaScriptExtensions: ReadonlySet<string> = new Set(['.js', '.jsx', '.mjs', '.cjs']);

export type SourceLanguage = 'typescript' | 'javascript';

export const languageOf = (path: string): SourceLanguage =>
  javaScriptExtensions.has(extensionOf(path)) ? 'javascript' : 'typescript';

export const scriptKindOf = (path: string): ts.ScriptKind => {
  switch (extensionOf(path)) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
};

export const parseSourceFile = (path: string, text: string): ts.SourceFile =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKindOf(path));
