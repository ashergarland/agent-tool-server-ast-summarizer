import ts from 'typescript';
import { boundedMessage } from '@agent-tool-platform/runtime/errors';

export interface ParseDiagnostic {
  readonly code: number;
  readonly category: 'error' | 'warning' | 'suggestion' | 'message';
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

/** `parseDiagnostics` is not part of the public compiler surface, so it is read defensively. */
interface SourceFileWithParseDiagnostics extends ts.SourceFile {
  readonly parseDiagnostics?: readonly ts.DiagnosticWithLocation[];
}

const categories: Readonly<Record<ts.DiagnosticCategory, ParseDiagnostic['category']>> = {
  [ts.DiagnosticCategory.Warning]: 'warning',
  [ts.DiagnosticCategory.Error]: 'error',
  [ts.DiagnosticCategory.Suggestion]: 'suggestion',
  [ts.DiagnosticCategory.Message]: 'message',
};

/**
 * Returns bounded syntax diagnostics so a caller can tell a recovered parse from a clean one.
 * Messages come from the compiler and are truncated; positions are relative to the file.
 */
export const parseDiagnosticsOf = (
  sourceFile: ts.SourceFile,
  maxDiagnostics: number,
): readonly ParseDiagnostic[] => {
  const raw = (sourceFile as SourceFileWithParseDiagnostics).parseDiagnostics ?? [];
  return raw.slice(0, maxDiagnostics).map((diagnostic) => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(diagnostic.start);
    return {
      code: diagnostic.code,
      category: categories[diagnostic.category],
      line: line + 1,
      column: character + 1,
      message: boundedMessage(ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')),
    };
  });
};

export const parseDiagnosticCount = (sourceFile: ts.SourceFile): number =>
  ((sourceFile as SourceFileWithParseDiagnostics).parseDiagnostics ?? []).length;
