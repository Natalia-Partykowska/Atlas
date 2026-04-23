import { describe, it, expect } from 'vitest'
import {
  auroraEquatorwardLat,
  kpLabel,
  kpColor,
  convertOvationToGeoJSON,
  generateAuroraWavyBands,
} from './aurora'
import type { OvationData } from './aurora'

// ── auroraEquatorwardLat ──────────────────────────────────────────────────────

describe('auroraEquatorwardLat', () => {
  it('returns 67 at Kp=0 (quietest)', () => {
    expect(auroraEquatorwardLat(0)).toBe(67)
  })

  it('returns 49 at Kp=9 (most active)', () => {
    expect(auroraEquatorwardLat(9)).toBe(49)
  })

  it('decreases linearly: each Kp step lowers boundary by 2°', () => {
    for (let kp = 0; kp <= 9; kp++) {
      expect(auroraEquatorwardLat(kp)).toBe(Math.max(45, 67 - kp * 2))
    }
  })

  it('never returns below 45 (floor clamped)', () => {
    expect(auroraEquatorwardLat(12)).toBe(45) // 67 - 24 = 43, but clamped to 45
    expect(auroraEquatorwardLat(100)).toBe(45)
  })

  it('Kp=11 still respects the 45° floor', () => {
    expect(auroraEquatorwardLat(11)).toBe(45)
  })
})

// ── kpLabel ───────────────────────────────────────────────────────────────────

describe('kpLabel', () => {
  it('returns "Quiet" for Kp 0–2', () => {
    expect(kpLabel(0)).toBe('Quiet')
    expect(kpLabel(1)).toBe('Quiet')
    expect(kpLabel(2)).toBe('Quiet')
  })

  it('returns "Moderate" for Kp 3–4', () => {
    expect(kpLabel(3)).toBe('Moderate')
    expect(kpLabel(4)).toBe('Moderate')
  })

  it('returns "Strong" for Kp 5–6', () => {
    expect(kpLabel(5)).toBe('Strong')
    expect(kpLabel(6)).toBe('Strong')
  })

  it('returns "Extreme" for Kp 7–9', () => {
    expect(kpLabel(7)).toBe('Extreme')
    expect(kpLabel(8)).toBe('Extreme')
    expect(kpLabel(9)).toBe('Extreme')
  })

  it('boundary between Quiet and Moderate is at Kp=2/3', () => {
    expect(kpLabel(2)).toBe('Quiet')
    expect(kpLabel(3)).toBe('Moderate')
  })

  it('boundary between Moderate and Strong is at Kp=4/5', () => {
    expect(kpLabel(4)).toBe('Moderate')
    expect(kpLabel(5)).toBe('Strong')
  })

  it('boundary between Strong and Extreme is at Kp=6/7', () => {
    expect(kpLabel(6)).toBe('Strong')
    expect(kpLabel(7)).toBe('Extreme')
  })
})

// ── kpColor ───────────────────────────────────────────────────────────────────

describe('kpColor', () => {
  it('returns green (#4ADE80) for Quiet (Kp 0–2)', () => {
    expect(kpColor(0)).toBe('#4ADE80')
    expect(kpColor(2)).toBe('#4ADE80')
  })

  it('returns yellow (#FACC15) for Moderate (Kp 3–4)', () => {
    expect(kpColor(3)).toBe('#FACC15')
    expect(kpColor(4)).toBe('#FACC15')
  })

  it('returns orange (#FB923C) for Strong (Kp 5–6)', () => {
    expect(kpColor(5)).toBe('#FB923C')
    expect(kpColor(6)).toBe('#FB923C')
  })

  it('returns red (#F87171) for Extreme (Kp 7+)', () => {
    expect(kpColor(7)).toBe('#F87171')
    expect(kpColor(9)).toBe('#F87171')
  })

  it('boundaries align with kpLabel boundaries', () => {
    // Color and label transitions should be at the same Kp values
    const colorAt = (kp: number) => kpColor(kp)
    expect(colorAt(2)).toBe(colorAt(0)) // both Quiet
    expect(colorAt(3)).not.toBe(colorAt(2)) // Quiet → Moderate
    expect(colorAt(4)).toBe(colorAt(3)) // both Moderate
    expect(colorAt(5)).not.toBe(colorAt(4)) // Moderate → Strong
    expect(colorAt(6)).toBe(colorAt(5)) // both Strong
    expect(colorAt(7)).not.toBe(colorAt(6)) // Strong → Extreme
  })
})

// ── convertOvationToGeoJSON ───────────────────────────────────────────────────

describe('convertOvationToGeoJSON', () => {
  const makeData = (coords: [number, number, number][]): OvationData => ({
    'Forecast Time': '2024-01-01T00:00:00Z',
    coordinates: coords,
  })

  it('returns a FeatureCollection', () => {
    const result = convertOvationToGeoJSON(makeData([]))
    expect(result.type).toBe('FeatureCollection')
  })

  it('returns an empty features array when all probabilities are ≤ 2', () => {
    const data = makeData([[0, 70, 0], [90, 65, 1], [180, 60, 2]])
    expect(convertOvationToGeoJSON(data).features).toHaveLength(0)
  })

  it('includes only coordinates with probability > 2', () => {
    const data = makeData([
      [0, 70, 2],   // excluded (≤ 2)
      [90, 65, 3],  // included
      [180, 60, 50], // included
    ])
    const { features } = convertOvationToGeoJSON(data)
    expect(features).toHaveLength(2)
  })

  it('stores probability as a feature property', () => {
    const data = makeData([[45, 70, 75]])
    const { features } = convertOvationToGeoJSON(data)
    expect(features[0].properties?.probability).toBe(75)
  })

  it('maps longitude > 180 to negative (0–360 → -180–180 convention)', () => {
    // NOAA uses 0–359 longitude; e.g. 270° → -90°
    const data = makeData([[270, 65, 50]])
    const { features } = convertOvationToGeoJSON(data)
    expect(features[0].geometry.coordinates[0]).toBeCloseTo(-90, 5)
  })

  it('leaves longitude ≤ 180 unchanged', () => {
    const data = makeData([[45, 70, 50], [180, 60, 50]])
    const { features } = convertOvationToGeoJSON(data)
    expect(features[0].geometry.coordinates[0]).toBe(45)
    expect(features[1].geometry.coordinates[0]).toBe(180)
  })

  it('preserves latitude unchanged', () => {
    const data = makeData([[0, 73.5, 50]])
    const { features } = convertOvationToGeoJSON(data)
    expect(features[0].geometry.coordinates[1]).toBe(73.5)
  })

  it('produces Point geometry for every feature', () => {
    const data = makeData([[0, 70, 50], [90, 65, 30]])
    const { features } = convertOvationToGeoJSON(data)
    for (const f of features) {
      expect(f.geometry.type).toBe('Point')
    }
  })
})

// ── generateAuroraWavyBands ───────────────────────────────────────────────────

describe('generateAuroraWavyBands', () => {
  it('returns a FeatureCollection', () => {
    const result = generateAuroraWavyBands(3, 0)
    expect(result.type).toBe('FeatureCollection')
  })

  it('produces exactly 12 features (6 zones × 2 hemispheres)', () => {
    expect(generateAuroraWavyBands(0, 0).features).toHaveLength(12)
    expect(generateAuroraWavyBands(9, 1).features).toHaveLength(12)
  })

  it('all features are Polygon geometry', () => {
    const { features } = generateAuroraWavyBands(5, 0)
    for (const f of features) {
      expect(f.geometry.type).toBe('Polygon')
    }
  })

  it('all polygon rings are closed (first vertex === last vertex)', () => {
    const { features } = generateAuroraWavyBands(3, 0)
    for (const f of features) {
      const ring = (f.geometry as GeoJSON.Polygon).coordinates[0]
      expect(ring[0][0]).toBeCloseTo(ring[ring.length - 1][0], 5)
      expect(ring[0][1]).toBeCloseTo(ring[ring.length - 1][1], 5)
    }
  })

  it('all features carry color and opacity properties', () => {
    const { features } = generateAuroraWavyBands(2, 0)
    for (const f of features) {
      expect(f.properties).toHaveProperty('color')
      expect(f.properties).toHaveProperty('opacity')
      expect(typeof f.properties!.color).toBe('string')
      expect(f.properties!.opacity).toBeGreaterThan(0)
      expect(f.properties!.opacity).toBeLessThanOrEqual(1)
    }
  })

  it('north hemisphere features have positive latitudes', () => {
    const { features } = generateAuroraWavyBands(3, 0)
    const northFeatures = features.filter((_, i) => i % 2 === 0) // every other is north
    for (const f of northFeatures) {
      const ring = (f.geometry as GeoJSON.Polygon).coordinates[0]
      const avgLat = ring.reduce((s, v) => s + v[1], 0) / ring.length
      expect(avgLat).toBeGreaterThan(0)
    }
  })

  it('south hemisphere features have negative latitudes', () => {
    const { features } = generateAuroraWavyBands(3, 0)
    const southFeatures = features.filter((_, i) => i % 2 === 1) // south follows north
    for (const f of southFeatures) {
      const ring = (f.geometry as GeoJSON.Polygon).coordinates[0]
      const avgLat = ring.reduce((s, v) => s + v[1], 0) / ring.length
      expect(avgLat).toBeLessThan(0)
    }
  })

  it('all latitudes stay within ±90°', () => {
    const { features } = generateAuroraWavyBands(9, Math.PI)
    for (const f of features) {
      const ring = (f.geometry as GeoJSON.Polygon).coordinates[0]
      for (const [, lat] of ring) {
        expect(lat).toBeGreaterThanOrEqual(-90)
        expect(lat).toBeLessThanOrEqual(90)
      }
    }
  })

  it('higher Kp pushes the oval equatorward (lower min lat in north)', () => {
    const lowKp = generateAuroraWavyBands(0, 0)
    const highKp = generateAuroraWavyBands(9, 0)

    const minNorthLat = (features: GeoJSON.Feature[]) =>
      Math.min(
        ...features
          .filter((_, i) => i % 2 === 0)
          .flatMap((f) => (f.geometry as GeoJSON.Polygon).coordinates[0].map(([, lat]) => lat))
      )

    expect(minNorthLat(highKp.features)).toBeLessThan(minNorthLat(lowKp.features))
  })

  it('phase shift changes the output (wavy bands are not static)', () => {
    const phase0 = generateAuroraWavyBands(3, 0)
    const phaseHalf = generateAuroraWavyBands(3, Math.PI / 2)
    const ring0 = (phase0.features[0].geometry as GeoJSON.Polygon).coordinates[0]
    const ringH = (phaseHalf.features[0].geometry as GeoJSON.Polygon).coordinates[0]
    // At least one latitude should differ between phase=0 and phase=π/2
    const differs = ring0.some((v, i) => Math.abs(v[1] - ringH[i][1]) > 0.01)
    expect(differs).toBe(true)
  })
})
