export type Inst =
  | { op: 'char'; c: string }
  | { op: 'charset'; chars: Set<string>; negate: boolean }
  | { op: 'any' }
  | { op: 'jmp'; to: number }
  | { op: 'split'; x: number; y: number }
  | { op: 'save'; slot: number }
  | { op: 'match' };

export interface Thread {
  pc: number;
  saved: (number | null)[];
}

export interface Program {
  insts: Inst[];
  numSlots: number;
}

function addThread(
  prog: Program,
  threads: Thread[],
  seen: Set<number>,
  pc: number,
  saved: (number | null)[],
  pos: number,
): void {
  if (pc >= prog.insts.length || seen.has(pc)) return;
  seen.add(pc);

  const inst = prog.insts[pc];

  switch (inst.op) {
    case 'jmp':
      addThread(prog, threads, seen, inst.to, saved, pos);
      break;
    case 'split':
      addThread(prog, threads, seen, inst.x, saved, pos);
      addThread(prog, threads, seen, inst.y, saved, pos);
      break;
    case 'save': {
      const newSaved = [...saved];
      newSaved[inst.slot] = pos;
      addThread(prog, threads, seen, pc + 1, newSaved, pos);
      break;
    }
    default:
      threads.push({ pc, saved });
  }
}

export function step(
  prog: Program,
  threads: Thread[],
  char: string,
  pos: number,
): Thread[] {
  const next: Thread[] = [];
  const seen = new Set<number>();

  for (const t of threads) {
    const inst = prog.insts[t.pc];

    switch (inst.op) {
      case 'char':
        if (char === inst.c) {
          addThread(prog, next, seen, t.pc + 1, t.saved, pos + 1);
        }
        break;
      case 'charset': {
        const match = inst.negate
          ? !inst.chars.has(char)
          : inst.chars.has(char);
        if (match) {
          addThread(prog, next, seen, t.pc + 1, t.saved, pos + 1);
        }
        break;
      }
      case 'any':
        addThread(prog, next, seen, t.pc + 1, t.saved, pos + 1);
        break;
    }
  }

  return next;
}

export function start(prog: Program, pos: number): Thread[] {
  const threads: Thread[] = [];
  const seen = new Set<number>();
  const saved = new Array(prog.numSlots).fill(null);
  addThread(prog, threads, seen, 0, saved, pos);
  return threads;
}
