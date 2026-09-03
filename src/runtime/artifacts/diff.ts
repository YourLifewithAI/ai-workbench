// A line diff, computed once on the server so the Library and the CLI show the same thing.
import type { DiffResponse } from '../../shared/api/index.js';

type Line = DiffResponse['lines'][number];

/** Longest common subsequence over lines: small documents, exact result, no dependency. */
export function diffLines(before: string, after: string): DiffResponse {
  const a = before.length ? before.split('\n') : [];
  const b = after.length ? after.split('\n') : [];
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const lines: Line[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: 'same', text: a[i]!, leftNo: i + 1, rightNo: j + 1 });
      i++; j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      lines.push({ kind: 'removed', text: a[i]!, leftNo: i + 1, rightNo: null });
      removed++; i++;
    } else {
      lines.push({ kind: 'added', text: b[j]!, leftNo: null, rightNo: j + 1 });
      added++; j++;
    }
  }
  for (; i < a.length; i++) { lines.push({ kind: 'removed', text: a[i]!, leftNo: i + 1, rightNo: null }); removed++; }
  for (; j < b.length; j++) { lines.push({ kind: 'added', text: b[j]!, leftNo: null, rightNo: j + 1 }); added++; }
  return { from: '', to: '', lines, added, removed };
}
