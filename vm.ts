export type Inst =
  | { op: 'ranges'; ranges: [number, number][]; negate: boolean }
  | { op: 'assert'; kind: 'bot' | 'eot' }
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

export interface BoundaryContext {
  atBot: boolean;
  prevCode: number | null;
}

function addThread(
  prog: Program,
  threads: Thread[],
  seen: Set<number>,
  pc: number,
  saved: (number | null)[],
  pos: number,
  context: BoundaryContext,
): void {
  if (pc >= prog.insts.length || seen.has(pc)) return;
  seen.add(pc);

  const inst = prog.insts[pc];

  switch (inst.op) {
    case 'jmp':
      addThread(prog, threads, seen, inst.to, saved, pos, context);
      break;
    case 'split':
      addThread(prog, threads, seen, inst.x, saved, pos, context);
      addThread(prog, threads, seen, inst.y, saved, pos, context);
      break;
    case 'save': {
      const newSaved = [...saved];
      newSaved[inst.slot] = pos;
      addThread(prog, threads, seen, pc + 1, newSaved, pos, context);
      break;
    }
    case 'assert':
      if (inst.kind === 'bot' && context.atBot)
        addThread(prog, threads, seen, pc + 1, saved, pos, context);
      else if (inst.kind === 'eot') threads.push({ pc, saved });
      break;
    default:
      threads.push({ pc, saved });
  }
}

export function addStartThread(
  prog: Program,
  threads: Thread[],
  seen: Set<number>,
  pos: number,
  context: BoundaryContext,
): void {
  const saved = new Array(prog.numSlots).fill(null);
  addThread(prog, threads, seen, 0, saved, pos, context);
}

export function step(
  prog: Program,
  threads: Thread[],
  char: string,
  pos: number,
  context: BoundaryContext,
): { threads: Thread[]; seen: Set<number> } {
  const next: Thread[] = [];
  const seen = new Set<number>();

  for (const t of threads) {
    const inst = prog.insts[t.pc];

    if (inst.op === 'ranges') {
      const code = char.charCodeAt(0);
      let hit = false;
      for (const [lo, hi] of inst.ranges) {
        if (code >= lo && code <= hi) {
          hit = true;
          break;
        }
      }
      if (hit !== inst.negate) {
        addThread(prog, next, seen, t.pc + 1, t.saved, pos + 1, context);
      }
    }
  }

  return { threads: next, seen };
}

export function resolveAsserts(
  prog: Program,
  threads: Thread[],
  pos: number,
  context: BoundaryContext,
): Thread[] {
  const out: Thread[] = [];
  const seen = new Set<number>();
  for (const t of threads) {
    const inst = prog.insts[t.pc];
    if (inst.op === 'assert' && inst.kind === 'eot')
      addThread(prog, out, seen, t.pc + 1, t.saved, pos, context);
    else if (inst.op === 'match') out.push(t);
  }
  return out;
}
