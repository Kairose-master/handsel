// A* 경로 탐색 (4방향) — 오피스 타일 그리드 전용
import { COLS, ROWS, walkable, type Pt } from "./world";

const DIRS = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
] as const;

/** 이진 힙 대신 작은 맵에서 충분히 빠른 정렬 삽입 큐 */
class Queue {
  private items: { idx: number; f: number }[] = [];

  push(idx: number, f: number) {
    let lo = 0;
    let hi = this.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.items[mid].f > f) lo = mid + 1;
      else hi = mid;
    }
    this.items.splice(lo, 0, { idx, f });
  }

  pop(): number | undefined {
    return this.items.pop()?.idx;
  }

  get size() {
    return this.items.length;
  }
}

/**
 * from → to 최단 경로. 시작 타일은 제외하고 목적지까지의 타일 배열을 반환한다.
 * 목적지가 막혀 있으면 인접한 걸을 수 있는 타일로 대체한다.
 */
export function findPath(from: Pt, to: Pt, blocked?: Set<number>): Pt[] {
  const start = idx(from.x, from.y);
  let goal = idx(to.x, to.y);

  if (!walkable(to.x, to.y)) {
    const alt = nearestWalkable(to);
    if (!alt) return [];
    goal = idx(alt.x, alt.y);
  }
  if (start === goal) return [];

  const came = new Int32Array(COLS * ROWS).fill(-1);
  const gScore = new Float32Array(COLS * ROWS).fill(Infinity);
  const closed = new Uint8Array(COLS * ROWS);
  const open = new Queue();

  gScore[start] = 0;
  open.push(start, heuristic(start, goal));

  while (open.size) {
    const current = open.pop()!;
    if (current === goal) return rebuild(came, current, start);
    if (closed[current]) continue;
    closed[current] = 1;

    const cx = current % COLS;
    const cy = (current / COLS) | 0;

    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!walkable(nx, ny)) continue;
      const next = idx(nx, ny);
      if (closed[next]) continue;
      // 다른 직원이 서 있는 칸은 비용을 크게 매겨 자연스럽게 돌아가게 한다
      const cost = blocked?.has(next) && next !== goal ? 6 : 1;
      const tentative = gScore[current] + cost;
      if (tentative >= gScore[next]) continue;
      came[next] = current;
      gScore[next] = tentative;
      open.push(next, tentative + heuristic(next, goal));
    }
  }
  return [];
}

function idx(x: number, y: number) {
  return y * COLS + x;
}

function heuristic(a: number, b: number) {
  const ax = a % COLS;
  const ay = (a / COLS) | 0;
  const bx = b % COLS;
  const by = (b / COLS) | 0;
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

function rebuild(came: Int32Array, goal: number, start: number): Pt[] {
  const path: Pt[] = [];
  let cursor = goal;
  while (cursor !== start && cursor !== -1) {
    path.push({ x: cursor % COLS, y: (cursor / COLS) | 0 });
    cursor = came[cursor];
  }
  return path.reverse();
}

function nearestWalkable(target: Pt): Pt | null {
  for (let r = 1; r <= 4; r += 1) {
    for (let dy = -r; dy <= r; dy += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const x = target.x + dx;
        const y = target.y + dy;
        if (walkable(x, y)) return { x, y };
      }
    }
  }
  return null;
}
