import { compile } from './compile';
import {
  addStartThread,
  Program,
  Thread,
  start,
  step,
  resolveAsserts,
} from './vm';

export interface Match {
  text: string;
  groups: string[];
  start: number;
}

export interface State {
  buffer: string;
  globalPos: number;
}

export type Replacement = string | ((match: Match) => string);

type MatchResult =
  | { status: 'match'; start: number; end: number; thread: Thread }
  | { status: 'none' }
  | { status: 'partial'; keepFrom: number };

function findMatch(
  prog: Program,
  text: string,
  offset: number,
  complete: boolean,
  atBot: boolean,
): MatchResult {
  let threads = start(prog, offset, atBot && offset === 0);
  let best: { start: number; end: number; thread: Thread } | null = null;

  const threadStart = (t: Thread) => t.saved[0] ?? offset;
  const threadEnd = (t: Thread) => t.saved[1] ?? threadStart(t);
  const isMatch = (t: Thread) => prog.insts[t.pc].op === 'match';

  for (let pos = offset; pos <= text.length; pos++) {
    let current = threads;
    const posAtBot = atBot && pos === 0;

    if (pos === text.length && complete) {
      current = resolveAsserts(prog, current, pos, posAtBot);
    }

    const matches = current.filter(isMatch);
    if (matches.length > 0) {
      let chosen = matches[0];
      for (const candidate of matches.slice(1)) {
        if (threadStart(candidate) < threadStart(chosen)) {
          chosen = candidate;
        }
      }

      const start = threadStart(chosen);
      const end = threadEnd(chosen);
      if (!best || start < best.start) {
        best = { start, end, thread: chosen };
      }

      const bestStart = best.start;
      current = current.filter(
        (t) => !isMatch(t) && threadStart(t) === bestStart,
      );
      if (current.length === 0) break;
    }

    if (pos === text.length) {
      if (!complete && current.length > 0) {
        const keepFrom = best
          ? best.start
          : current.reduce(
              (earliest, t) => Math.min(earliest, threadStart(t)),
              text.length,
            );
        return { status: 'partial', keepFrom };
      }
      break;
    }

    const next = step(prog, current, text[pos], pos, false);
    if (!best) addStartThread(prog, next.threads, next.seen, pos + 1, false);
    threads = next.threads;
  }

  return best ? { status: 'match', ...best } : { status: 'none' };
}

function extractGroups(
  saved: (number | null)[],
  source: string,
): string[] {
  const groups: string[] = [];
  for (let i = 2; i < saved.length; i += 2) {
    const s = saved[i];
    const e = saved[i + 1];
    groups.push(s !== null && e !== null ? source.slice(s, e) : '');
  }
  return groups;
}

function applyReplacement(
  replacement: Replacement,
  text: string,
  groups: string[],
  start: number,
): string {
  const match: Match = { text, groups, start };
  if (typeof replacement === 'function') return replacement(match);
  return replacement.replace(/\$(\$|&|\d+)/g, (_, token) => {
    if (token === '$') return '$';
    if (token === '&') return text;
    const n = +token;
    return groups[n - 1] ?? '';
  });
}

export function process(
  prog: Program,
  replacement: Replacement,
  state: State,
  chunk: string,
  flush: boolean,
): { output: string; state: State } {
  let { buffer, globalPos } = state;
  buffer += chunk;
  let output = '';
  let pos = 0;
  let consumedFinalEmptyMatch = false;

  while (pos < buffer.length) {
    const result = findMatch(prog, buffer, pos, flush, globalPos === 0);

    switch (result.status) {
      case 'match': {
        const { start, end, thread } = result;
        output += buffer.slice(pos, start);

        const text = buffer.slice(start, end);
        const groups = extractGroups(thread.saved, buffer);
        output += applyReplacement(
          replacement,
          text,
          groups,
          globalPos + (start - pos),
        );

        if (start === end) {
          if (flush && end === buffer.length) consumedFinalEmptyMatch = true;
          const nextChar = buffer[end];
          if (nextChar !== undefined) {
            output += nextChar;
            globalPos += end + 1 - pos;
            pos = end + 1;
          } else {
            globalPos += end - pos;
            pos = end;
          }
        } else {
          globalPos += end - pos;
          pos = end;
        }
        break;
      }

      case 'none':
        output += buffer.slice(pos);
        globalPos += buffer.length - pos;
        pos = buffer.length;
        break;

      case 'partial':
        output += buffer.slice(pos, result.keepFrom);
        globalPos += result.keepFrom - pos;
        return {
          output,
          state: {
            buffer: buffer.slice(result.keepFrom),
            globalPos,
          },
        };
    }
  }

  if (flush && !consumedFinalEmptyMatch) {
    const result = findMatch(prog, buffer, pos, true, globalPos === 0);
    if (result.status === 'match' && result.start === pos && result.end === pos) {
      const groups = extractGroups(result.thread.saved, '');
      output += applyReplacement(replacement, '', groups, globalPos);
    }
  }

  return { output, state: { buffer: '', globalPos } };
}

export function replaceInStream({
  pattern,
  replacement,
}: {
  pattern: RegExp | string;
  replacement: Replacement;
}): TransformStream<string, string> {
  const prog =
    typeof pattern === 'string' ? compile(pattern) : compile(pattern.source);
  let state: State = { buffer: '', globalPos: 0 };

  return new TransformStream({
    transform(chunk, controller) {
      const result = process(prog, replacement, state, chunk, false);
      state = result.state;
      if (result.output) controller.enqueue(result.output);
    },
    flush(controller) {
      const { output, state: final } = process(
        prog,
        replacement,
        state,
        '',
        true,
      );
      controller.enqueue(output + final.buffer);
    },
  });
}
