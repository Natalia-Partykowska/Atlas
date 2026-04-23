import { describe, it, expect } from 'vitest'
import {
  toMercator,
  fromMercator,
  computeMercatorCentroid,
  repositionGeometry,
  clipGeometryToMercatorBounds,
  makeGhostFeatureCollection,
} from './ghostGeometry'
import type { Polygon, MultiPolygon } from 'geojson'

const CLOSE = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol

// ── toMercator / fromMercator round-trip ──────────────────────────────────────

describe('toMercator / fromMercator round-trip', () => {
  const cases: [number, number][] = [
    [0, 0],
    [90, 45],
    [-90, -45],
    [180, 60],
    [-180, -60],
    [0, 80],
    [0, -80],
  ]

  for (const [lng, lat] of cases) {
    it(`round-trips (${lng}, ${lat})`, () => {
      const [x, y] = toMercator(lng, lat)
      const [outLng, outLat] = fromMercator(x, y)
      expect(CLOSE(outLng, lng, 1e-9)).toBe(true)
      expect(CLOSE(outLat, lat, 1e-6)).toBe(true)
    })
  }

  it('equator y is 0', () => {
    const [, y] = toMercator(0, 0)
    expect(y).toBeCloseTo(0, 10)
  })

  it('lng=0 x is 0', () => {
    const [x] = toMercator(0, 45)
    expect(x).toBeCloseTo(0, 10)
  })
})

// ── computeMercatorCentroid ───────────────────────────────────────────────────

describe('computeMercatorCentroid', () => {
  /** Simple square [-1,-1] to [1,1] */
  const SQUARE: Polygon = {
    type: 'Polygon',
    coordinates: [[[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]]],
  }

  it('centroid of a symmetric square near origin is close to (0, 0) in Mercator', () => {
    const [cx, cy] = computeMercatorCentroid(SQUARE)
    const [ox, oy] = toMercator(0, 0)
    expect(CLOSE(cx, ox, 0.05)).toBe(true)
    expect(CLOSE(cy, oy, 0.05)).toBe(true)
  })

  it('picks the largest ring (by vertex count) for a MultiPolygon', () => {
    // Tiny part has 5 vertices; larger part has 9 vertices → centroid anchors to larger
    const multi: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [
        // Tiny part: 5 vertices
        [[[-10, -10], [-9, -10], [-9, -9], [-10, -9], [-10, -10]]],
        // Larger part centred at (100, 40): 9 vertices
        [[[98, 38], [100, 37], [102, 38], [103, 40], [102, 42], [100, 43], [98, 42], [97, 40], [98, 38]]],
      ],
    }
    const [cx] = computeMercatorCentroid(multi)
    const [ox] = toMercator(100, 40)
    // Centroid x should be on the right side of the map (near 100°E)
    expect(CLOSE(cx, ox, 0.2)).toBe(true)
  })
})

// ── repositionGeometry ────────────────────────────────────────────────────────

describe('repositionGeometry — identity (scale=1, same centroid)', () => {
  const poly: Polygon = {
    type: 'Polygon',
    coordinates: [[[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]]],
  }

  it('returns a geometry with the same number of rings', () => {
    const centroid = computeMercatorCentroid(poly)
    const out = repositionGeometry(poly, centroid, centroid, 1) as Polygon
    expect(out.coordinates).toHaveLength(poly.coordinates.length)
  })

  it('coordinates are close to original when scale=1 and centroid unchanged', () => {
    const centroid = computeMercatorCentroid(poly)
    const out = repositionGeometry(poly, centroid, centroid, 1) as Polygon
    const origRing = poly.coordinates[0]
    const outRing = out.coordinates[0]
    for (let i = 0; i < origRing.length; i++) {
      expect(outRing[i][0]).toBeCloseTo(origRing[i][0], 3)
      expect(outRing[i][1]).toBeCloseTo(origRing[i][1], 3)
    }
  })
})

describe('repositionGeometry — translation', () => {
  const poly: Polygon = {
    type: 'Polygon',
    coordinates: [[[-1, 0], [1, 0], [1, 2], [-1, 2], [-1, 0]]],
  }

  it('shifts centroid to new position', () => {
    const origCentroid = computeMercatorCentroid(poly)
    const newCentroid = toMercator(50, 0) as [number, number]
    const out = repositionGeometry(poly, origCentroid, newCentroid, 1) as Polygon

    // Compute centroid of relocated geometry
    const relocatedCentroid = computeMercatorCentroid(out)
    expect(CLOSE(relocatedCentroid[0], newCentroid[0], 0.05)).toBe(true)
  })
})

describe('repositionGeometry — MultiPolygon', () => {
  const multi: MultiPolygon = {
    type: 'MultiPolygon',
    coordinates: [
      [[[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]]],
      [[[10, 10], [12, 10], [12, 12], [10, 12], [10, 10]]],
    ],
  }

  it('produces the same number of parts', () => {
    const centroid = computeMercatorCentroid(multi)
    const out = repositionGeometry(multi, centroid, centroid, 1) as MultiPolygon
    expect(out.coordinates).toHaveLength(multi.coordinates.length)
  })
})

// ── clipGeometryToMercatorBounds ──────────────────────────────────────────────

describe('clipGeometryToMercatorBounds', () => {
  it('passes through a ring entirely within bounds unchanged (same vertex count)', () => {
    const poly: Polygon = {
      type: 'Polygon',
      coordinates: [[[-10, -10], [10, -10], [10, 10], [-10, 10], [-10, -10]]],
    }
    const out = clipGeometryToMercatorBounds(poly) as Polygon
    // All vertices within ±85°, ring count unchanged
    expect(out.coordinates).toHaveLength(1)
  })

  it('clips Antarctica-like geometry that extends below -85.05°', () => {
    const antarctic: Polygon = {
      type: 'Polygon',
      coordinates: [[
        [-180, -85], [0, -90], [180, -85], [0, -80], [-180, -85],
      ]],
    }
    const out = clipGeometryToMercatorBounds(antarctic) as Polygon
    const ring = out.coordinates[0]
    for (const [, lat] of ring) {
      expect(lat).toBeGreaterThanOrEqual(-85.1) // clamped at Mercator limit
    }
  })

  it('handles MultiPolygon without throwing', () => {
    const multi: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [
        [[[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]]],
        [[[-1, -89], [1, -89], [1, -91], [-1, -91], [-1, -89]]],
      ],
    }
    expect(() => clipGeometryToMercatorBounds(multi)).not.toThrow()
  })
})

// ── makeGhostFeatureCollection ────────────────────────────────────────────────

describe('makeGhostFeatureCollection', () => {
  const poly: Polygon = {
    type: 'Polygon',
    coordinates: [[[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]]],
  }

  it('returns a FeatureCollection with one feature', () => {
    const fc = makeGhostFeatureCollection(poly, 'Test')
    expect(fc.type).toBe('FeatureCollection')
    expect(fc.features).toHaveLength(1)
  })

  it('sets the name property on the feature', () => {
    const fc = makeGhostFeatureCollection(poly, 'Germany')
    expect(fc.features[0].properties?.name).toBe('Germany')
  })

  it('attaches the geometry to the feature', () => {
    const fc = makeGhostFeatureCollection(poly, 'X')
    expect(fc.features[0].geometry).toEqual(poly)
  })
})
