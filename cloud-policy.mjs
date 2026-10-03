export const TEXT_THRESHOLD = 10;
export const IDLE_DELAY = 60000;
// Count Unicode code points, including equal-length replacements. Only the
// distance up to 10 matters; a banded edit-distance calculation bounds work.
export function changedCharacters(before = '', after = '') {
  if (before === after) return 0;
  const a = Array.from(before), b = Array.from(after);
  let start = 0, endA = a.length, endB = b.length;
  while (start < endA && start < endB && a[start] === b[start]) start++;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const n = endA - start, m = endB - start, cap = TEXT_THRESHOLD;
  if (Math.abs(n - m) >= cap) return cap;
  if (!n || !m) return Math.min(cap, Math.max(n, m));
  let previous = new Map();
  for (let j = 0; j <= Math.min(m, cap); j++) previous.set(j, j);
  for (let i = 1; i <= n; i++) {
    const current = new Map(); let minimum = cap;
    for (let j = Math.max(0, i - cap); j <= Math.min(m, i + cap); j++) {
      const cost = j === 0 ? Math.min(i, cap) : Math.min(cap,
        (previous.get(j) ?? cap) + 1, (current.get(j - 1) ?? cap) + 1,
        (previous.get(j - 1) ?? cap) + (a[start + i - 1] === b[start + j - 1] ? 0 : 1));
      current.set(j, cost); minimum = Math.min(minimum, cost);
    }
    if (minimum >= cap) return cap;
    previous = current;
  }
  return previous.get(m) ?? cap;
}
export const pendingCharacters = m => Math.max(0, (m.textChanges ?? 0) - (m.acknowledgedTextChanges ?? 0));
export const dirty = m => m.revision > m.acknowledgedRevision;
export const eager = m => !!m.attempt || (m.immediateRevision ?? 0) > m.acknowledgedRevision ||
  pendingCharacters(m) >= TEXT_THRESHOLD || !Number.isFinite(m.lastEditAt);
export const ready = (m, now = Date.now()) => dirty(m) && (eager(m) || now - m.lastEditAt >= IDLE_DELAY);
