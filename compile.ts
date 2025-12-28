import { Inst, Program } from './vm';

export type RE =
  | { type: 'char'; c: string }
  | { type: 'any' }
  | { type: 'charset'; chars: Set<string>; negate: boolean }
  | { type: 'seq'; items: RE[] }
  | { type: 'alt'; left: RE; right: RE }
  | { type: 'star'; body: RE }
  | { type: 'plus'; body: RE }
  | { type: 'opt'; body: RE }
  | { type: 'group'; body: RE };

function parse(pattern: string): { re: RE; numSlots: number } {
  let i = 0, numSlots = 0;
  const peek = () => pattern[i];
  const next = () => pattern[i++];
  const consume = (c: string) => peek() === c && (next(), true);

  function parseCharClass(): RE {
    const negate = consume('^');
    const chars = new Set<string>();
    const read = () => (consume('\\') ? next() : next());
    while (peek() && peek() !== ']') {
      const start = read().charCodeAt(0);
      const end = peek() === '-' && pattern[i + 1] !== ']'
        ? (next(), read().charCodeAt(0))
        : start;
      for (let c = start; c <= end; c++) chars.add(String.fromCharCode(c));
    }
    if (!consume(']')) throw new Error('Unclosed [');
    return { type: 'charset', chars, negate };
  }

  function parseAtom(): RE | null {
    const c = peek();
    if (c === undefined || '*+?)|'.includes(c)) return null;
    switch (c) {
      case '[': next(); return parseCharClass();
      case '(': {
        next();
        const body = parseAlt();
        if (!consume(')')) throw new Error('Unclosed (');
        numSlots += 2;
        return { type: 'group', body };
      }
      case '.': next(); return { type: 'any' };
      case '\\': {
        next();
        const escaped = next();
        if (escaped === undefined) throw new Error('Trailing \\');
        return { type: 'char', c: escaped };
      }
      default: next(); return { type: 'char', c };
    }
  }

  function parseFactor(): RE | null {
    const atom = parseAtom();
    if (!atom) return null;
    switch (peek()) {
      case '*': next(); return { type: 'star', body: atom };
      case '+': next(); return { type: 'plus', body: atom };
      case '?': next(); return { type: 'opt', body: atom };
      default: return atom;
    }
  }

  function parseTerm(): RE {
    const items: RE[] = [];
    for (let f; (f = parseFactor()); ) items.push(f);
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
      case 'char': emit({ op: 'char', c: re.c }); break;
      case 'any': emit({ op: 'any' }); break;
      case 'charset': emit({ op: 'charset', chars: re.chars, negate: re.negate }); break;
      case 'seq': re.items.forEach(gen); break;
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
