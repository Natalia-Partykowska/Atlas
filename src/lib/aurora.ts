import type { Feature, FeatureCollection, Point, Polygon } from 'geojson'

const DEG = Math.PI / 180

/**
 * Approximate geomagnetic latitude of the aurora oval's equatorward boundary.
 * Empirical formula: aurora reaches ~67° at Kp=0, ~49° at Kp=9.
 */
export function auroraEquatorwardLat(kp: number): number {
  return Math.max(45, 67 - kp * 2)
}

/** Map Kp index to activity label */
export function kpLabel(kp: number): string {
  if (kp <= 2) return 'Quiet'
  if (kp <= 4) return 'Moderate'
  if (kp <= 6) return 'Strong'
  return 'Extreme'
}

/** Map Kp index to a CSS color for the badge */
export function kpColor(kp: number): string {
  if (kp <= 2) return '#4ADE80'
  if (kp <= 4) return '#FACC15'
  if (kp <= 6) return '#FB923C'
  return '#F87171'
}

// [fractionFrom, fractionTo, color, opacity, ampScale]
const ZONES: [number, number, string, number, number][] = [
  [0.0, 0.2, '#818CF8', 0.07, 1.8], // equatorward diffuse purple
  [0.12, 0.48, '#4ADE80', 0.2, 1.3], // green lower
  [0.38, 0.7, '#86EFAC', 0.27, 0.9], // green core (brightest)
  [0.6, 0.83, '#34D399', 0.19, 1.1], // green→teal upper
  [0.75, 0.92, '#C084FC', 0.13, 1.2], // purple upper
  [0.88, 1.0, '#E879F9', 0.08, 0.6], // polar cap faint
]

/**
 * Build a wavy latitude-band polygon for one hemisphere.
 * @param equatorwardLat  the latitude where the aurora starts (e.g. 55°)
 * @param fracLow         fraction of the polar cap occupied by the lower edge (0 = equatorward boundary)
 * @param fracHigh        fraction of the polar cap occupied by the upper edge (1 = pole)
 * @param sign            +1 for north, -1 for south
 * @param color           hex fill color
 * @param opacity         fill opacity
 * @param ampScale        amplitude multiplier for waves
 * @param phase           animation phase offset in radians
 */
function makeWavyBand(
  equatorwardLat: number,
  fracLow: number,
  fracHigh: number,
  sign: number,
  color: string,
  opacity: number,
  ampScale: number,
  phase: number,
): Feature<Polygon> {
  const polarSpan = 90 - equatorwardLat // degrees from equatorward boundary to pole
  const baseLow = equatorwardLat + fracLow * polarSpan
  const baseHigh = equatorwardLat + fracHigh * polarSpan
  const N = 180 // vertices per edge

  const wave = (lng: number) =>
    ampScale * (1.6 * Math.sin(3 * lng * DEG + phase) + 0.8 * Math.sin(7 * lng * DEG + phase * 1.7))

  const top: [number, number][] = []
  const bottom: [number, number][] = []

  for (let i = 0; i <= N; i++) {
    const lng = -180 + (360 * i) / N
    const w = wave(lng)
    top.push([lng, Math.min(89.9, sign * (baseHigh + w))])
    bottom.push([lng, Math.min(89.9, sign * (baseLow + w))])
  }

  // Build ring: bottom left→right, top right→left, close
  const ring: [number, number][] = [
    ...bottom,
    ...[...top].reverse(),
    bottom[0],
  ]

  return {
    type: 'Feature',
    properties: { color, opacity },
    geometry: { type: 'Polygon', coordinates: [ring] },
  }
}

// ── NOAA Ovation real-data types ─────────────────────────────────────────────

export interface OvationData {
  'Forecast Time': string
  coordinates: [number, number, number][] // [lng 0-359, lat, probability 0-100]
}

/** Convert NOAA Ovation aurora probability grid to a GeoJSON FeatureCollection. */
export function convertOvationToGeoJSON(data: OvationData): FeatureCollection<Point> {
  const features = data.coordinates
    .filter(([, , prob]) => prob > 2)
    .map(([lng, lat, prob]) => ({
      type: 'Feature' as const,
      properties: { probability: prob },
      geometry: {
        type: 'Point' as const,
        coordinates: [lng > 180 ? lng - 360 : lng, lat],
      },
    }))
  return { type: 'FeatureCollection', features }
}

// ── Wavy-band fallback ────────────────────────────────────────────────────────

/**
 * Generate wavy aurora band FeatureCollection for both hemispheres.
 * @param kp    Kp index (0–9)
 * @param phase Animation phase in radians
 */
export function generateAuroraWavyBands(kp: number, phase: number): FeatureCollection {
  const equatorwardLat = auroraEquatorwardLat(kp)
  const features: Feature[] = []

  for (const [fracLow, fracHigh, color, opacity, ampScale] of ZONES) {
    // North hemisphere
    features.push(makeWavyBand(equatorwardLat, fracLow, fracHigh, 1, color, opacity, ampScale, phase))
    // South hemisphere (phase-shifted for independent shimmer)
    features.push(makeWavyBand(equatorwardLat, fracLow, fracHigh, -1, color, opacity, ampScale, phase + Math.PI))
  }

  return { type: 'FeatureCollection', features }
}
