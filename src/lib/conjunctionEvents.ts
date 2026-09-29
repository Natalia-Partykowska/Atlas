import type { ConjunctionEvent } from './orbitStream'

// Keeps the Conjunctions list steady across the server's 10 s batches.
//
// Each screening pass samples 13 instants 10 min apart, so a fast pair is only
// caught when a sample lands within seconds of its closest approach. Measured
// live, only ~50% of one batch is still in the next. Replacing the list with
// each batch made rows (and the selected pair, mid-callout) vanish, so batches
// are merged instead: an event stays until its closest approach has passed,
// and the selected pair stays until the user lets go of it.

export interface ConjunctionPair {
  noradA: number
  noradB: number
}

/** A pair's TCA moving less than this between batches is the same approach,
 *  re-estimated. Repeat passes of one pair are ≥ ~40 min apart. */
export const SAME_APPROACH_TOLERANCE_MS = 5 * 60_000
/** How long a row stays after its closest approach. */
export const PASSED_GRACE_MS = 60_000
/** The drawer renders at most this many rows, soonest first. */
export const MAX_VISIBLE_ROWS = 100

/** Order-independent key: A↔B and B↔A are the same pair. */
export function conjunctionPairKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`
}

export function isSamePair(e: ConjunctionPair, sel: ConjunctionPair | null): boolean {
  if (!sel) return false
  return (
    (e.noradA === sel.noradA && e.noradB === sel.noradB) ||
    (e.noradA === sel.noradB && e.noradB === sel.noradA)
  )
}

function isExpired(e: ConjunctionEvent, now: number): boolean {
  return e.tcaEpochMs + PASSED_GRACE_MS < now
}

/** Drops events more than `PASSED_GRACE_MS` past their closest approach,
 *  except the selected pair. Returns `events` itself when nothing is dropped. */
export function pruneConjunctionEvents(
  events: ConjunctionEvent[],
  now: number,
  selected: ConjunctionPair | null,
): ConjunctionEvent[] {
  const kept = events.filter((e) => !isExpired(e, now) || isSamePair(e, selected))
  return kept.length === events.length ? events : kept
}

/**
 * Merges one batch into the list: one row per pair, sorted by TCA.
 *
 * An incoming event takes over its pair's row when the row is new, when it's
 * the same approach re-estimated (fresher miss / Δv / midpoint), when it's a
 * sooner approach, or when the stored one is over and not selected. A pair
 * missing from the batch keeps its row.
 */
export function mergeConjunctionEvents(
  prev: ConjunctionEvent[],
  incoming: ConjunctionEvent[],
  now: number,
  selected: ConjunctionPair | null,
): ConjunctionEvent[] {
  const byPair = new Map<string, ConjunctionEvent>()
  for (const e of prev) byPair.set(conjunctionPairKey(e.noradA, e.noradB), e)

  for (const e of incoming) {
    const key = conjunctionPairKey(e.noradA, e.noradB)
    const stored = byPair.get(key)
    if (
      !stored ||
      Math.abs(e.tcaEpochMs - stored.tcaEpochMs) <= SAME_APPROACH_TOLERANCE_MS ||
      e.tcaEpochMs < stored.tcaEpochMs ||
      (isExpired(stored, now) && !isSamePair(stored, selected))
    ) {
      byPair.set(key, e)
    }
  }

  return pruneConjunctionEvents([...byPair.values()], now, selected).sort(
    (a, b) => a.tcaEpochMs - b.tcaEpochMs,
  )
}
