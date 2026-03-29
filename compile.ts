import { Inst, Program } from './vm';

type Ranges = [number, number][];
type Esc = { ranges: Ranges; negate: boolean } | { code: number };

export type Expr =
  | { type: 'alternation'; branches: Expr[] }
  | { type: 'sequence'; parts: Expr[] }
  | {
      type: 'repeat';
      child: Expr;
      min: number;
      max: number | null;
      greedy: boolean;
    }
  | { type: 'group'; child: Expr; capturing: boolean; slot?: number }
  | { type: 'ranges'; ranges: Ranges; negate: boolean }
  | { type: 'assert'; kind: 'bot' | 'eot' };

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

const META = new Set('*+?()|[]{}\\.-'.split(''));

function resolveEscape(c: string): Esc {
  const e = ESCAPES[c];
  if (e) return e;
  if (META.has(c)) return { code: c.charCodeAt(0) };
  throw new Error(`Invalid escape \\${c}`);
}

export function parse(pattern: string): Expr {
  let i = 0;

  const peek = () => pattern[i];
  const next = () => pattern[i++];
  const consume = (c: string) => peek() === c && (next(), true);

  function readEscape(): Esc {
    const c = next();
    if (c === undefined) throw new Error('Trailing \\');
    return resolveEscape(c);
  }

  function literal(code: number): Expr {
    return { type: 'ranges', ranges: [[code, code]], negate: false };
  }

  function parseCharClass(): Expr {
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
        const c = next();
        if (c === undefined) throw new Error('Unclosed [');
        e = { code: c.charCodeAt(0) };
      }

      const start = e.code;
      const end =
        peek() === '-' && pattern[i + 1] !== ']'
          ? (next(),
            consume('\\')
              ? readEscape()
              : (() => {
                  const c = next();
                  if (c === undefined) throw new Error('Unclosed [');
                  return { code: c.charCodeAt(0) };
                })())
          : { code: start };

      if ('ranges' in end)
        throw new Error('Cannot use class shorthand as range endpoint');
      ranges.push([start, end.code]);
    }

    if (!consume(']')) throw new Error('Unclosed [');
    return { type: 'ranges', ranges, negate };
  }

  function parseAtom(): Expr | null {
    const c = peek();
    if (c === undefined || '*+?)|}'.includes(c)) return null;

    switch (c) {
      case '[':
        next();
        return parseCharClass();
      case '(': {
        next();
        let capturing = true;
        if (consume('?')) {
          if (!consume(':')) throw new Error('Unsupported group syntax');
          capturing = false;
        }
        const child = parseAlternation();
        if (!consume(')')) throw new Error('Unclosed (');
        return { type: 'group', child, capturing };
      }
      case '^':
        next();
        return { type: 'assert', kind: 'bot' };
      case '$':
        next();
        return { type: 'assert', kind: 'eot' };
      case '.':
        next();
        return { type: 'ranges', ranges: [[10, 10]], negate: true };
      case '\\':
        next();
        return emitEscapeNode(readEscape());
      default:
        next();
        return literal(c.charCodeAt(0));
    }
  }

  function emitEscapeNode(e: Esc): Expr {
    return 'code' in e
      ? literal(e.code)
      : { type: 'ranges', ranges: e.ranges, negate: e.negate };
  }

  function parseRepeat(child: Expr): Expr {
    next();
    let num = '';
    while (peek() && peek() >= '0' && peek() <= '9') num += next();
    if (num === '') throw new Error('Expected repeat count');
    const min = +num;
    let max = min;

    if (consume(',')) {
      num = '';
      while (peek() && peek() >= '0' && peek() <= '9') num += next();
      max = num === '' ? Infinity : +num;
    }

    if (!consume('}')) throw new Error('Unclosed {');
    if (max < min) throw new Error('Repeat range out of order');
    return {
      type: 'repeat',
      child,
      min,
      max: max === Infinity ? null : max,
      greedy: !consume('?'),
    };
  }

  function parseFactor(): Expr | null {
    const child = parseAtom();
    if (!child) return null;

    switch (peek()) {
      case '*':
        next();
        return {
          type: 'repeat',
          child,
          min: 0,
          max: null,
          greedy: !consume('?'),
        };
      case '+':
        next();
        return {
          type: 'repeat',
          child,
          min: 1,
          max: null,
          greedy: !consume('?'),
        };
      case '?':
        next();
        return { type: 'repeat', child, min: 0, max: 1, greedy: !consume('?') };
      case '{':
        return parseRepeat(child);
      default:
        return child;
    }
  }

  function parseSequence(): Expr {
    const parts: Expr[] = [];
    let part: Expr | null;
    while ((part = parseFactor())) parts.push(part);
    return { type: 'sequence', parts };
  }

  function parseAlternation(): Expr {
    const branches = [parseSequence()];
    while (consume('|')) branches.push(parseSequence());
    return branches.length === 1
      ? branches[0]
      : { type: 'alternation', branches };
  }

  const expr = parseAlternation();
  if (peek() !== undefined) throw new Error(`Unexpected ${peek()}`);
  return expr;
}

// Compiles an AST as-is. Callers that intend to execute the program through
// the stream matcher should usually use compile(), which wraps the AST in the
// implicit whole-match capture stored in slots 0/1.
export function compileAst(expr: Expr): Program {
  const insts: Inst[] = [];
  let numSlots = 0;

  const emit = (inst: Inst) => (insts.push(inst), insts.length - 1);

  function compileExpr(node: Expr): void {
    switch (node.type) {
      case 'alternation':
        compileAlternation(node.branches);
        break;
      case 'sequence':
        for (const part of node.parts) compileExpr(part);
        break;
      case 'repeat':
        compileRepeat(node);
        break;
      case 'group':
        if (!node.capturing) {
          compileExpr(node.child);
          break;
        }
        {
          const slot = node.slot ?? numSlots;
          if (node.slot === undefined) {
            node.slot = slot;
            numSlots += 2;
          }
          emit({ op: 'save', slot });
          compileExpr(node.child);
          emit({ op: 'save', slot: slot + 1 });
        }
        break;
      case 'ranges':
        emit({ op: 'ranges', ranges: node.ranges, negate: node.negate });
        break;
      case 'assert':
        emit({ op: 'assert', kind: node.kind });
        break;
    }
  }

  function compileAlternation(branches: Expr[]): void {
    function compileBranch(index: number): void {
      if (index >= branches.length) return;
      if (index === branches.length - 1) {
        compileExpr(branches[index]);
        return;
      }

      const split = emit({ op: 'split', x: 0, y: 0 });
      const leftStart = insts.length;
      compileExpr(branches[index]);
      const jump = emit({ op: 'jmp', to: 0 });
      const rightStart = insts.length;
      compileBranch(index + 1);
      insts[split] = { op: 'split', x: leftStart, y: rightStart };
      insts[jump] = { op: 'jmp', to: insts.length };
    }

    compileBranch(0);
  }

  function compileRepeat(node: Extract<Expr, { type: 'repeat' }>): void {
    for (let r = 0; r < node.min; r++) compileExpr(node.child);

    if (node.max === null) {
      compileStar(node.child, node.greedy);
      return;
    }

    for (let r = 0; r < node.max - node.min; r++) {
      compileOptional(node.child, node.greedy);
    }
  }

  function compileStar(child: Expr, greedy: boolean): void {
    const split = emit({ op: 'split', x: 0, y: 0 });
    const bodyStart = insts.length;
    compileExpr(child);
    emit({ op: 'jmp', to: split });
    const end = insts.length;
    const [x, y] = greedy ? [bodyStart, end] : [end, bodyStart];
    insts[split] = { op: 'split', x, y };
  }

  function compileOptional(child: Expr, greedy: boolean): void {
    const split = emit({ op: 'split', x: 0, y: 0 });
    const bodyStart = insts.length;
    compileExpr(child);
    const end = insts.length;
    const [x, y] = greedy ? [bodyStart, end] : [end, bodyStart];
    insts[split] = { op: 'split', x, y };
  }

  compileExpr(expr);
  emit({ op: 'match' });
  return { insts, numSlots };
}

export function compile(pattern: string): Program {
  // Reserve slots 0/1 for the whole match so the VM can track unanchored
  // search starts without adding extra thread metadata.
  return compileAst({
    type: 'group',
    child: parse(pattern),
    capturing: true,
  });
}
