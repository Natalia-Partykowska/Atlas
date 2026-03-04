/** Compute the antipodal point (exact opposite side of Earth) */
export function computeAntipode(lng: number, lat: number): [number, number] {
  const antipodeLng = lng >= 0 ? lng - 180 : lng + 180
  return [antipodeLng, -lat]
}

interface OceanRegion {
  name: string
  check: (lng: number, lat: number) => boolean
}

// Simple bounding-box ocean lookup (ordered by specificity)
const OCEANS: OceanRegion[] = [
  { name: 'Arctic', check: (_lng, lat) => lat > 70 },
  { name: 'Southern', check: (_lng, lat) => lat < -55 },
  {
    name: 'Indian',
    check: (lng, lat) => lng > 20 && lng < 150 && lat < 30 && lat > -55,
  },
  {
    name: 'Pacific',
    check: (lng, lat) => (lng > 120 || lng < -70) && lat < 65 && lat > -55,
  },
  {
    name: 'Atlantic',
    check: (lng, lat) => lng > -70 && lng < 20 && lat > -55 && lat < 65,
  },
]

/** Identify which ocean a coordinate likely falls in. Returns null if on land. */
export function identifyOcean(lng: number, lat: number): string {
  for (const ocean of OCEANS) {
    if (ocean.check(lng, lat)) return ocean.name
  }
  return 'Pacific' // fallback
}

/** Well-known antipode pairs for fun facts */
export const NOTABLE_ANTIPODES: Array<{
  a: string
  b: string
  hint: string
}> = [
  { a: 'Spain', b: 'New Zealand', hint: 'Spain ↔ New Zealand' },
  { a: 'Argentina', b: 'China', hint: 'Argentina ↔ China' },
  { a: 'Hawaii', b: 'Botswana', hint: 'Hawaii ↔ Botswana' },
]
