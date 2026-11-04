/**
 * Reciprocal rank fusion (Cormack et al., 2009): each ranked list adds
 * 1 / (k + rank) to every item it contains. Ranks fuse where raw scores
 * cannot — BM25, a title match tier, and a cosine similarity have no common
 * scale — and an item two lists agree on rises above one only a single list
 * likes. k = 60 is the paper's value and was kept after measuring it.
 */
export const RRF_K = 60;

export interface RankedList {
  source: string;
  /** Best first. */
  ids: readonly string[];
}

export interface FusedRank {
  id: string;
  score: number;
  /** Lists that contained the id, in the order the lists were given. */
  sources: string[];
}

export function fuseRankings(lists: readonly RankedList[], k: number = RRF_K): FusedRank[] {
  const fused = new Map<string, FusedRank>();
  for (const list of lists) {
    const seen = new Set<string>();
    list.ids.forEach((id, index) => {
      if (seen.has(id)) return;
      seen.add(id);
      const entry = fused.get(id) ?? { id, score: 0, sources: [] };
      entry.score += 1 / (k + index + 1);
      entry.sources.push(list.source);
      fused.set(id, entry);
    });
  }
  return [...fused.values()];
}

/**
 * The wire's `searchScore` is "lower is better" so several hosts' pages merge
 * by sorting ascending. A fused score is "higher is better"; its reciprocal
 * keeps the order and stays positive.
 */
export function fusedScoreToSearchScore(score: number): number {
  return 1 / score;
}
