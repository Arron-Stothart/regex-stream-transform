import { Match } from "./types";

export function streamReplace(
  pattern: RegExp | string,
  replacement: string | ((match: Match) => string)
): TransformStream<string, string> {
  throw new Error('Not implemented');
}

