export type Inst =
  | { op: 'char'; c: string }
  | { op: 'any' }
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
): { threads: Thread[]; matched: Thread | null } {
  const next: Thread[] = [];
  const seen = new Set<number>();
  let matched: Thread | null = null;

  for (const t of threads) {
    const inst = prog.insts[t.pc];

    switch (inst.op) {
      case 'char':
        if (char === inst.c) {
          addThread(prog, next, seen, t.pc + 1, t.saved, pos + 1);
        }
        break;
      case 'any':
        addThread(prog, next, seen, t.pc + 1, t.saved, pos + 1);
        break;
      case 'match':
        if (!matched) matched = t;
        break;
    }
  }

  return { threads: next, matched };
}

export function start(prog: Program, pos: number): Thread[] {
  const threads: Thread[] = [];
  const seen = new Set<number>();
  const saved = new Array(prog.numSlots).fill(null);
  addThread(prog, threads, seen, 0, saved, pos);
  return threads;
}
