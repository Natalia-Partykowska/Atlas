import type { CountryDataMap } from '@/types/atlas'
import { interpolateColor } from './colorScales'

const NO_DATA_COLOR = '#1E2A3A'

export function buildMatchExpression(
  data: CountryDataMap,
  colorLow: string,
  colorHigh: string,
): unknown[] {
  const values = Object.values(data).filter((v) => isFinite(v) && v >= 0)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1

  const pairs: (string | number)[] = []
  for (const [iso, value] of Object.entries(data)) {
    const t = Math.max(0, Math.min(1, (value - min) / range))
    pairs.push(iso, interpolateColor(colorLow, colorHigh, t))
  }

  // ['match', ['get', 'ISO_A3_EH'], iso1, color1, iso2, color2, ..., default]
  // ISO_A3_EH is more complete — ISO_A3 is '-99' for Norway, France, etc.
  return ['match', ['get', 'ISO_A3_EH'], ...pairs, NO_DATA_COLOR]
}

export { NO_DATA_COLOR }
