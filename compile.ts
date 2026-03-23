import { Inst, Program } from './vm';

type Ranges = [number, number][];

export type RE =
  | { type: 'ranges'; ranges: Ranges; negate: boolean }
  | { type: 'seq'; items: RE[] }
  | { type: 'alt'; left: RE; right: RE }
  | { type: 'star'; body: RE }
  | { type: 'plus'; body: RE }
  | { type: 'opt'; body: RE }
  | { type: 'group'; body: RE };

type Escape = { ranges: Ranges; negate: boolean } | { code: number };

const ESCAPES: Record<string, Escape> = {
  t: { code: 9 },
  n: { code: 10 },
  r: { code: 13 },
  f: { code: 12 },
  v: { code: 11 },
  a: { code: 7 },
  '0': { code: 0 },
  d: { ranges: [[48, 57]], negate: false },
  D: { ranges: [[48, 57]], negate: true },
  w: {
    ranges: [
      [48, 57],
      [65, 90],
      [97, 122],
      [95, 95],
    ],
    negate: false,
  },
  W: {
    ranges: [
      [48, 57],
      [65, 90],
      [97, 122],
      [95, 95],
    ],
    negate: true,
  },
  s: {
    ranges: [
      [9, 13],
      [32, 32],
    ],
    negate: false,
  },
  S: {
    ranges: [
      [9, 13],
      [32, 32],
    ],
    negate: true,
  },
};

const META = new Set('*+?()|[]{}\\.^$-'.split(''));

function cc(code: number): RE {
  return { type: 'ranges', ranges: [[code, code]], negate: false };
}

function resolveEscape(c: string): Escape {
  const e = ESCAPES[c];
  if (e) return e;
  if (META.has(c)) return { code: c.charCodeAt(0) };
  throw new Error(`Invalid escape \\${c}`);
}

function escapeToRE(e: Escape): RE {
  if ('code' in e) return cc(e.code);
  return { type: 'ranges', ranges: e.ranges, negate: e.negate };
}

function parse(pattern: string): { re: RE; numSlots: number } {
  let i = 0;
  let numSlots = 0;
  const peek = () => pattern[i];
  const next = () => pattern[i++];
  const consume = (c: string) => peek() === c && (next(), true);

  function readEscape(): Escape {
    const c = next();
    if (c === undefined) throw new Error('Trailing \\');
    return resolveEscape(c);
  }

  function parseCharClass(): RE {
    const negate = consume('^');
    const ranges: Ranges = [];

    while (peek() && peek() !== ']') {
      let e: Escape;
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
    return { type: 'ranges', ranges, negate };
  }

  function parseAtom(): RE | null {
    const c = peek();
    if (c === undefined || '*+?)|'.includes(c)) return null;
    switch (c) {
      case '[':
        next();
        return parseCharClass();
      case '(': {
        next();
        const body = parseAlt();
        if (!consume(')')) throw new Error('Unclosed (');
        numSlots += 2;
        return { type: 'group', body };
      }
      case '.':
        next();
        return { type: 'ranges', ranges: [[10, 10]], negate: true };
      case '\\':
        next();
        return escapeToRE(readEscape());
      default:
        next();
        return cc(c.charCodeAt(0));
    }
  }

  function parseFactor(): RE | null {
    const atom = parseAtom();
    if (!atom) return null;
    switch (peek()) {
      case '*':
        next();
        return { type: 'star', body: atom };
      case '+':
        next();
        return { type: 'plus', body: atom };
      case '?':
        next();
        return { type: 'opt', body: atom };
      default:
        return atom;
    }
  }

  function parseTerm(): RE {
    const items: RE[] = [];
    let f;
    while ((f = parseFactor())) items.push(f);
    return items.length === 1 ? items[0] : { type: 'seq', items };
  }

  function parseAlt(): RE {
    let left = parseTerm();
    while (consume('|')) left = { type: 'alt', left, right: parseTerm() };
    return left;
  }

  return { re: parseAlt(), numSlots };
}

export function compile(pattern: string): Program {
  const { re, numSlots } = parse(pattern);
  const insts: Inst[] = [];
  let slotIndex = 0;
  const emit = (inst: Inst) => (insts.push(inst), insts.length - 1);

  function gen(re: RE): void {
    switch (re.type) {
      case 'ranges':
        emit({ op: 'ranges', ranges: re.ranges, negate: re.negate });
        break;
      case 'seq':
        re.items.forEach(gen);
        break;
      case 'alt': {
        const s = emit({ op: 'split', x: 0, y: 0 });
        const leftStart = insts.length;
        gen(re.left);
        const j = emit({ op: 'jmp', to: 0 });
        const rightStart = insts.length;
        gen(re.right);
        insts[s] = { op: 'split', x: leftStart, y: rightStart };
        insts[j] = { op: 'jmp', to: insts.length };
        break;
      }
      case 'star': {
        const s = emit({ op: 'split', x: 0, y: 0 });
        const bodyStart = insts.length;
        gen(re.body);
        emit({ op: 'jmp', to: s });
        insts[s] = { op: 'split', x: bodyStart, y: insts.length };
        break;
      }
      case 'plus': {
        const bodyStart = insts.length;
        gen(re.body);
        emit({ op: 'split', x: bodyStart, y: insts.length + 1 });
        break;
      }
      case 'opt': {
        const s = emit({ op: 'split', x: 0, y: 0 });
        const bodyStart = insts.length;
        gen(re.body);
        insts[s] = { op: 'split', x: bodyStart, y: insts.length };
        break;
      }
      case 'group': {
        const slot = slotIndex;
        slotIndex += 2;
        emit({ op: 'save', slot });
        gen(re.body);
        emit({ op: 'save', slot: slot + 1 });
        break;
      }
    }
  }

  gen(re);
  emit({ op: 'match' });
  return { insts, numSlots };
}
