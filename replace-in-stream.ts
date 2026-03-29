import { compile } from './compile';
import {
  addStartThread,
  BoundaryContext,
  Program,
  Thread,
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
  context: BoundaryContext;
}

export type Replacement = string | ((match: Match) => string);

type MatchResult =
  | { status: 'match'; start: number; end: number; thread: Thread }
  | { status: 'none' }
  | { status: 'partial'; keepFrom: number };

export function initialState(): State {
  return {
    buffer: '',
    globalPos: 0,
    context: { atBot: true, prevCode: null },
  };
}

function boundaryAt(
  context: BoundaryContext,
  text: string,
  pos: number,
): BoundaryContext {
  if (pos === 0) return context;
  return { atBot: false, prevCode: text.charCodeAt(pos - 1) };
}

function boundaryAfterChar(code: number): BoundaryContext {
  return { atBot: false, prevCode: code };
}

function advanceContext(
  context: BoundaryContext,
  text: string,
): BoundaryContext {
  if (text.length === 0) return context;
  return {
    atBot: false,
    prevCode: text.charCodeAt(text.length - 1),
  };
}

function findMatch(
  prog: Program,
  text: string,
  offset: number,
  complete: boolean,
  context: BoundaryContext,
): MatchResult {
  let threads: Thread[] = [];
  const seen = new Set<number>();
  addStartThread(
    prog,
    threads,
    seen,
    offset,
    boundaryAt(context, text, offset),
  );
  let best: { start: number; end: number; thread: Thread } | null = null;

  const threadStart = (t: Thread) => {
    const start = t.saved[0];
    if (start === null) throw new Error('Missing whole-match start slot');
    return start;
  };
  const threadEnd = (t: Thread) => {
    const end = t.saved[1];
    if (end === null) throw new Error('Missing whole-match end slot');
    return end;
  };
  const isMatch = (t: Thread) => prog.insts[t.pc].op === 'match';

  for (let pos = offset; pos <= text.length; pos++) {
    let current = threads;
    const boundary = boundaryAt(context, text, pos);

    if (pos === text.length && complete) {
      current = resolveAsserts(prog, current, pos, boundary);
    }

    const matchIndex = current.findIndex(isMatch);
    if (matchIndex >= 0) {
      const match = current[matchIndex];
      const start = threadStart(match);
      const end = threadEnd(match);
      if (
        !best ||
        start < best.start ||
        (start === best.start && end > best.end)
      ) {
        best = { start, end, thread: match };
      }

      const bestStart = best.start;
      current = current
        .slice(0, matchIndex)
        .filter((t) => threadStart(t) === bestStart);
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

    const nextBoundary = boundaryAfterChar(text.charCodeAt(pos));
    const next = step(prog, current, text[pos], pos, nextBoundary);
    if (!best)
      addStartThread(prog, next.threads, next.seen, pos + 1, nextBoundary);
    threads = next.threads;
  }

  return best ? { status: 'match', ...best } : { status: 'none' };
}

function extractGroups(saved: (number | null)[], source: string): string[] {
  const groups: string[] = [];
  // Slots 0/1 are the implicit whole-match capture inserted by compile().
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
  let { buffer, globalPos, context } = state;
  buffer += chunk;
  let output = '';
  let pos = 0;

  while (true) {
    const result = findMatch(prog, buffer, pos, flush, context);

    switch (result.status) {
      case 'match': {
        const { start, end, thread } = result;
        const prefix = buffer.slice(pos, start);
        output += prefix;
        globalPos += prefix.length;
        context = advanceContext(context, prefix);

        const text = buffer.slice(start, end);
        const groups = extractGroups(thread.saved, buffer);
        output += applyReplacement(replacement, text, groups, globalPos);

        if (start === end) {
          const nextChar = buffer[end];
          if (nextChar !== undefined) {
            output += nextChar;
            globalPos++;
            context = advanceContext(context, nextChar);
            pos = end + 1;
            break;
          }
          return { output, state: { buffer: '', globalPos, context } };
        }

        globalPos += text.length;
        context = advanceContext(context, text);
        pos = end;
        break;
      }

      case 'none':
        if (pos === buffer.length) {
          return { output, state: { buffer: '', globalPos, context } };
        }
        {
          const rest = buffer.slice(pos);
          output += rest;
          globalPos += rest.length;
          context = advanceContext(context, rest);
        }
        pos = buffer.length;
        break;

      case 'partial':
        {
          const safe = buffer.slice(pos, result.keepFrom);
          output += safe;
          globalPos += safe.length;
          context = advanceContext(context, safe);
        }
        return {
          output,
          state: {
            buffer: buffer.slice(result.keepFrom),
            globalPos,
            context,
          },
        };
    }
  }

  return { output, state: { buffer: '', globalPos, context } };
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
  let state = initialState();

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
