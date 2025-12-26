import { compile } from './compile';
import { Program, Thread, start, step } from './vm';

export interface Match {
  text: string;
  groups: string[];
  start: number;
}

type MatchResult =
  | { status: 'match'; end: number; thread: Thread }
  | { status: 'none' }
  | { status: 'partial' };

function findMatch(
  prog: Program,
  text: string,
  complete: boolean,
): MatchResult {
  let threads = start(prog, 0);
  let best: { end: number; thread: Thread } | null = null;

  for (let i = 0; i <= text.length; i++) {
    const match = threads.find((t) => prog.insts[t.pc].op === 'match');
    if (match) best = { end: i, thread: match };

    const active = threads.filter((t) => prog.insts[t.pc].op !== 'match');

    if (i === text.length) {
      if (!complete && active.length > 0) return { status: 'partial' };
      break;
    }

    if (active.length === 0) break;

    threads = step(prog, active, text[i], i).threads;
  }

  return best ? { status: 'match', ...best } : { status: 'none' };
}

type Replacement = string | ((match: Match) => string);

function extractGroups(saved: (number | null)[], source: string): string[] {
  const groups: string[] = [];
  for (let i = 0; i < saved.length; i += 2) {
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
  return replacement.replace(/\$(\d+)/g, (_, n) =>
    n === '0' ? text : (groups[+n - 1] ?? ''),
  );
}

interface State {
  buffer: string;
  globalPos: number;
  atEnd: boolean;
}

function process(
  prog: Program,
  replacement: Replacement,
  state: State,
  chunk: string,
  flush: boolean,
): { output: string; state: State } {
  let { buffer, globalPos, atEnd } = state;
  buffer += chunk;
  let output = '';

  while (true) {
    // Check for final empty match at end of stream
    if (flush && buffer.length === 0 && !atEnd) {
      atEnd = true;
      const result = findMatch(prog, '', true);
      if (result.status === 'match') {
        const groups = extractGroups(result.thread.saved, '');
        output += applyReplacement(replacement, '', groups, globalPos);
      }
      return { output, state: { buffer, globalPos, atEnd } };
    }

    if (buffer.length === 0) {
      return { output, state: { buffer, globalPos, atEnd } };
    }

    const result = findMatch(prog, buffer, flush);

    switch (result.status) {
      case 'match': {
        const { end, thread } = result;
        const text = buffer.slice(0, end);
        const groups = extractGroups(thread.saved, buffer);
        output += applyReplacement(replacement, text, groups, globalPos);

        if (end === 0) {
          output += buffer[0];
          buffer = buffer.slice(1);
          globalPos++;
        } else {
          buffer = buffer.slice(end);
          globalPos += end;
        }
        break;
      }

      case 'none':
        output += buffer[0];
        buffer = buffer.slice(1);
        globalPos++;
        break;

      case 'partial':
        return { output, state: { buffer, globalPos, atEnd } };
    }
  }
}

export function streamReplace(
  pattern: RegExp | string,
  replacement: Replacement,
): TransformStream<string, string> {
  const prog =
    typeof pattern === 'string' ? compile(pattern) : compile(pattern.source);
  let state: State = { buffer: '', globalPos: 0, atEnd: false };

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
