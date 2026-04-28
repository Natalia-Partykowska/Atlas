import type { CountryDataMap, ISO3 } from '@/types/atlas'

// Memoise sorted descending entries per layerData reference. The map's
// values are stable for the lifetime of a layer load, and Object.entries +
// .sort would otherwise run on every hover. WeakMap so we don't pin GC.
const sortedCache = new WeakMap<CountryDataMap, Array<[ISO3, number]>>()

function getSortedEntries(data: CountryDataMap): Array<[ISO3, number]> {
  const cached = sortedCache.get(data)
  if (cached) return cached
  // Same filter the Legend uses for min/max — keeps rank consistent with the
  // value range shown to the user (no negative / non-finite outliers).
  const sorted = Object.entries(data)
    .filter(([, v]) => Number.isFinite(v) && v >= 0)
    .sort((a, b) => b[1] - a[1])
  sortedCache.set(data, sorted)
  return sorted
}

// Returns the 1-based rank of `iso3` in the layer's value distribution
// (descending), plus the total number of finite ranked entries. Returns
// null if no data is loaded, no iso is supplied, or the country isn't in
// the dataset.
export function countryRank(
  data: CountryDataMap | null,
  iso3: ISO3 | null | undefined,
): { rank: number; total: number } | null {
  if (!data || !iso3) return null
  const sorted = getSortedEntries(data)
  const idx = sorted.findIndex(([k]) => k === iso3)
  if (idx === -1) return null
  return { rank: idx + 1, total: sorted.length }
}

function ordinalSuffix(n: number): string {
  const lastTwo = n % 100
  if (lastTwo >= 11 && lastTwo <= 13) return 'th'
  switch (n % 10) {
    case 1:
      return 'st'
    case 2:
      return 'nd'
    case 3:
      return 'rd'
    default:
      return 'th'
  }
}

export function formatRank(rank: number, total: number): string {
  return `${rank}${ordinalSuffix(rank)} of ${total}`
}
