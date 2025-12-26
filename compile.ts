import { Inst, Program } from './vm';

export function compile(pattern: string): Program {
  const insts: Inst[] = [];
  let numSlots = 0;
  let i = 0;

  function emit(inst: Inst): number {
    insts.push(inst);
    return insts.length - 1;
  }

  function peek(): string | undefined {
    return pattern[i];
  }

  function next(): string {
    return pattern[i++];
  }

  function parseAtom(): { start: number } | null {
    const c = peek();
    if (c === undefined || '*+?|)'.includes(c)) return null;

    const start = insts.length;

    switch (c) {
      case '(': {
        next();
        const slot = numSlots;
        numSlots += 2;
        emit({ op: 'save', slot });
        parseExpr();
        if (peek() !== ')') throw new Error('Unclosed (');
        next();
        emit({ op: 'save', slot: slot + 1 });
        break;
      }

      case '.':
        next();
        emit({ op: 'any' });
        break;

      case '\\': {
        next();
        const escaped = next();
        if (escaped === undefined) throw new Error('Trailing \\');
        emit({ op: 'char', c: escaped });
        break;
      }

      default:
        next();
        emit({ op: 'char', c });
    }

    return { start };
  }

  function parseFactor(): void {
    const atom = parseAtom();
    if (!atom) return;

    const c = peek();
    if (c !== '*' && c !== '+' && c !== '?') return;

    next();
    const { start } = atom;
    const body = insts.splice(start);

    switch (c) {
      case '*': {
        const splitPos = emit({ op: 'split', x: 0, y: 0 });
        const bodyStart = insts.length;
        body.forEach((inst) => emit(inst));
        emit({ op: 'jmp', to: splitPos });
        insts[splitPos] = { op: 'split', x: bodyStart, y: insts.length };
        break;
      }

      case '+': {
        const bodyStart = insts.length;
        body.forEach((inst) => emit(inst));
        emit({ op: 'split', x: bodyStart, y: insts.length + 1 });
        break;
      }

      case '?': {
        const splitPos = emit({ op: 'split', x: 0, y: 0 });
        const bodyStart = insts.length;
        body.forEach((inst) => emit(inst));
        insts[splitPos] = { op: 'split', x: bodyStart, y: insts.length };
        break;
      }
    }
  }

  function parseTerm(): void {
    while (peek() !== undefined && peek() !== ')') {
      parseFactor();
    }
  }

  function parseExpr(): void {
    parseTerm();
  }

  parseExpr();
  emit({ op: 'match' });

  return { insts, numSlots };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const tests = ['abc', 'a.c', 'a*', 'a+', 'a?', 'a(.)c', '(a*)', '\\.'];

  for (const pattern of tests) {
    console.log(`\n"${pattern}":`);
    const prog = compile(pattern);
    prog.insts.forEach((inst, idx) => {
      console.log(`  ${idx}: ${JSON.stringify(inst)}`);
    });
    console.log(`  slots: ${prog.numSlots}`);
  }
}
