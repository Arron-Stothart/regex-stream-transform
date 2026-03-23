import { compile } from './compile';
import { Program, Thread, start, step, resolveAsserts } from './vm';

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
  | { status: 'match'; end: number; thread: Thread }
  | { status: 'none' }
  | { status: 'partial' };

function findMatch(
  prog: Program,
  text: string,
  offset: number,
  complete: boolean,
): MatchResult {
  const len = text.length;
  let threads = start(prog, 0);
  let best: { end: number; thread: Thread } | null = null;

  for (let i = 0; i <= len - offset; i++) {
    const match = threads.find((t) => prog.insts[t.pc].op === 'match');
    if (match) best = { end: i, thread: match };

    const active = threads.filter((t) => prog.insts[t.pc].op !== 'match');

    if (offset + i === len) {
      if (!complete && active.length > 0) return { status: 'partial' };
      if (complete) {
        const resolved = resolveAsserts(prog, active, i);
        const m = resolved.find((t) => prog.insts[t.pc].op === 'match');
        if (m) best = { end: i, thread: m };
      }
      break;
    }

    if (active.length === 0) break;

    threads = step(prog, active, text[offset + i], i);
  }

  return best ? { status: 'match', ...best } : { status: 'none' };
}

function extractGroups(
  saved: (number | null)[],
  source: string,
  offset: number,
): string[] {
  const groups: string[] = [];
  for (let i = 0; i < saved.length; i += 2) {
    const s = saved[i];
    const e = saved[i + 1];
    groups.push(
      s !== null && e !== null ? source.slice(offset + s, offset + e) : '',
    );
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

  while (pos < buffer.length) {
    const result = findMatch(prog, buffer, pos, flush);

    switch (result.status) {
      case 'match': {
        const { end, thread } = result;
        const text = buffer.slice(pos, pos + end);
        const groups = extractGroups(thread.saved, buffer, pos);
        output += applyReplacement(replacement, text, groups, globalPos);

        if (end === 0) {
          output += buffer[pos];
          pos++;
          globalPos++;
        } else {
          pos += end;
          globalPos += end;
        }
        break;
      }

      case 'none':
        output += buffer[pos];
        pos++;
        globalPos++;
        break;

      case 'partial':
        return {
          output,
          state: { buffer: buffer.slice(pos), globalPos },
        };
    }
  }

  if (flush) {
    const result = findMatch(prog, '', 0, true);
    if (result.status === 'match') {
      const groups = extractGroups(result.thread.saved, '', 0);
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
