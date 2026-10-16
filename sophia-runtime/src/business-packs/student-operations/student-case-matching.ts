export function normalizedCollege(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

// Normalized Levenshtein similarity: 1 - edit distance / longest name.
// No substring shortcut: short references such as VISA must not match a school.
export function collegeSimilarity(left: string, right: string): number {
  const a = normalizedCollege(left), b = normalizedCollege(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) current[j] = Math.min(
      current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
    );
    previous = current;
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}

export function matchCollege(reference: string, colleges: Array<{ college_id: string; college_name: string }>) {
  const ranked = colleges.map(college => ({ ...college, score: collegeSimilarity(reference, college.college_name) }))
    .sort((a, b) => b.score - a.score || a.college_id.localeCompare(b.college_id));
  const best = ranked[0];
  if (!best || best.score < 0.7) return { match: null, reason: 'below_threshold', candidates: ranked.slice(0, 2) };
  if (ranked[1] && ranked[1].score >= 0.7 && best.score - ranked[1].score < 0.05)
    return { match: null, reason: 'ambiguous_match', candidates: ranked.slice(0, 2) };
  return { match: best, reason: 'matched', candidates: ranked.slice(0, 2) };
}
