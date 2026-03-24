import { Inst, Program } from './vm';

type Ranges = [number, number][];
type Esc = { ranges: Ranges; negate: boolean } | { code: number };

const ESCAPES: Record<string, Esc> = {
  t: { code: 9 },
  n: { code: 10 },
  r: { code: 13 },
  f: { code: 12 },
  v: { code: 11 },
  a: { code: 7 },
  '0': { code: 0 },
  d: { ranges: [[48, 57]], negate: false },
  D: { ranges: [[48, 57]], negate: true },
  w: { ranges: [[48, 57], [65, 90], [97, 122], [95, 95]], negate: false },
  W: { ranges: [[48, 57], [65, 90], [97, 122], [95, 95]], negate: true },
  s: { ranges: [[9, 13], [32, 32]], negate: false },
  S: { ranges: [[9, 13], [32, 32]], negate: true },
};

const META = new Set('*+?()|[]{}\\.-'.split(''));

function resolveEscape(c: string): Esc {
  const e = ESCAPES[c];
  if (e) return e;
  if (META.has(c)) return { code: c.charCodeAt(0) };
  throw new Error(`Invalid escape \\${c}`);
}

export function compile(pattern: string): Program {
  const insts: Inst[] = [];
  let i = 0;
  let numSlots = 0;
  type Emit = () => void;

  const peek = () => pattern[i];
  const next = () => pattern[i++];
  const consume = (c: string) => peek() === c && (next(), true);
  const emit = (inst: Inst) => (insts.push(inst), insts.length - 1);

  function readEscape(): Esc {
    const c = next();
    if (c === undefined) throw new Error('Trailing \\');
    return resolveEscape(c);
  }

  function emitRanges(e: Esc): void {
    if ('code' in e)
      emit({ op: 'ranges', ranges: [[e.code, e.code]], negate: false });
    else emit({ op: 'ranges', ranges: e.ranges, negate: e.negate });
  }

  function charClass(): Emit {
    const negate = consume('^');
    const ranges: Ranges = [];

    while (peek() && peek() !== ']') {
      let e: Esc;
      if (consume('\\')) {
        e = readEscape();
        if ('ranges' in e) {
          ranges.push(...e.ranges);
          continue;
        }
      } else {
        e = { code: next().charCodeAt(0) };
      }
      const start = e.code;
      const end =
        peek() === '-' && pattern[i + 1] !== ']'
          ? (next(),
            consume('\\') ? readEscape() : { code: next().charCodeAt(0) })
          : { code: start };
      if ('ranges' in end)
        throw new Error('Cannot use class shorthand as range endpoint');
      ranges.push([start, end.code]);
    }
    if (!consume(']')) throw new Error('Unclosed [');
    return () => emit({ op: 'ranges', ranges, negate });
  }

  function atom(): Emit | null {
    const c = peek();
    if (c === undefined || '*+?)|}'.includes(c)) return null;
    switch (c) {
      case '[':
        next();
        return charClass();
      case '(': {
        next();
        const capturing = !(consume('?') && consume(':'));
        const inner = alt();
        if (!consume(')')) throw new Error('Unclosed (');
        if (!capturing) return inner;
        const slot = numSlots;
        numSlots += 2;
        return () => {
          emit({ op: 'save', slot });
          inner();
          emit({ op: 'save', slot: slot + 1 });
        };
      }
      case '^':
        next();
        return () => emit({ op: 'assert', kind: 'bot' });
      case '$':
        next();
        return () => emit({ op: 'assert', kind: 'eot' });
      case '.':
        next();
        return () => emit({ op: 'ranges', ranges: [[10, 10]], negate: true });
      case '\\': {
        next();
        const e = readEscape();
        return () => emitRanges(e);
      }
      default: {
        next();
        const code = c.charCodeAt(0);
        return () =>
          emit({ op: 'ranges', ranges: [[code, code]], negate: false });
      }
    }
  }

  function star(body: Emit, greedy: boolean): Emit {
    return () => {
      const s = emit({ op: 'split', x: 0, y: 0 });
      const bodyStart = insts.length;
      body();
      emit({ op: 'jmp', to: s });
      const end = insts.length;
      const [x, y] = greedy ? [bodyStart, end] : [end, bodyStart];
      insts[s] = { op: 'split', x, y };
    };
  }

  function plus(body: Emit, greedy: boolean): Emit {
    return () => {
      const bodyStart = insts.length;
      body();
      const end = insts.length + 1;
      const [x, y] = greedy ? [bodyStart, end] : [end, bodyStart];
      emit({ op: 'split', x, y });
    };
  }

  function opt(body: Emit, greedy: boolean): Emit {
    return () => {
      const s = emit({ op: 'split', x: 0, y: 0 });
      const bodyStart = insts.length;
      body();
      const end = insts.length;
      const [x, y] = greedy ? [bodyStart, end] : [end, bodyStart];
      insts[s] = { op: 'split', x, y };
    };
  }

  function repeat(body: Emit): Emit {
    next();
    let num = '';
    while (peek() && peek() >= '0' && peek() <= '9') num += next();
    const min = num === '' ? 0 : +num;
    let max = min;
    if (consume(',')) {
      num = '';
      while (peek() && peek() >= '0' && peek() <= '9') num += next();
      max = num === '' ? Infinity : +num;
    }
    if (!consume('}')) throw new Error('Unclosed {');
    const greedy = !consume('?');

    return () => {
      for (let r = 0; r < min; r++) body();
      if (max === Infinity) star(body, greedy)();
      else for (let r = 0; r < max - min; r++) opt(body, greedy)();
    };
  }

  function factor(): Emit | null {
    const body = atom();
    if (!body) return null;
    switch (peek()) {
      case '*':
        next();
        return star(body, !consume('?'));
      case '+':
        next();
        return plus(body, !consume('?'));
      case '?':
        next();
        return opt(body, !consume('?'));
      case '{':
        return repeat(body);
      default:
        return body;
    }
  }

  function term(): Emit {
    const parts: Emit[] = [];
    let f;
    while ((f = factor())) parts.push(f);
    return () => parts.forEach((f) => f());
  }

  function alt(): Emit {
    let left = term();
    while (consume('|')) {
      const prev = left;
      const right = term();
      left = () => {
        const s = emit({ op: 'split', x: 0, y: 0 });
        const leftStart = insts.length;
        prev();
        const j = emit({ op: 'jmp', to: 0 });
        const rightStart = insts.length;
        right();
        insts[s] = { op: 'split', x: leftStart, y: rightStart };
        insts[j] = { op: 'jmp', to: insts.length };
      };
    }
    return left;
  }

  alt()();
  emit({ op: 'match' });
  return { insts, numSlots };
}
