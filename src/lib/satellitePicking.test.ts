import { describe, it, expect } from 'vitest'
import { pickNearestSatellite } from './satellitePicking'
import type { SatPosition } from './satellites'

// Minimal stub of the bits of maplibregl.Map our function reads.
function makeStubMap(
  projectFn: (lngLat: [number, number]) => { x: number; y: number },
  canvasW = 1000,
  canvasH = 800,
) {
  return {
    project: projectFn,
    getCanvas: () => ({ clientWidth: canvasW, clientHeight: canvasH }),
  } as unknown as Parameters<typeof pickNearestSatellite>[0]
}

function sat(norad: number, lng: number, lat: number): SatPosition {
  return { norad, name: String(norad), group: 'active', lng, lat, altitudeKm: 500 }
}

describe('pickNearestSatellite', () => {
  it('returns the closest satellite within the pixel radius', () => {
    // Synthetic projection: each NORAD lands at the lng value in pixel space.
    const map = makeStubMap(([lng]) => ({ x: lng, y: 100 }))
    const positions = new Map<number, SatPosition>([
      [1, sat(1, 100, 0)],
      [2, sat(2, 110, 0)],
      [3, sat(3, 200, 0)],
    ])
    const hit = pickNearestSatellite(map, { x: 105, y: 100 }, positions, 12)
    // Distances: 5px (sat 1), 5px (sat 2), 95px (sat 3). Picks first encountered
    // at the same distance; check it's one of {1, 2}.
    expect(hit?.norad === 1 || hit?.norad === 2).toBe(true)
  })

  it('returns null when nothing is within radius', () => {
    const map = makeStubMap(([lng]) => ({ x: lng, y: 100 }))
    const positions = new Map<number, SatPosition>([
      [42, sat(42, 500, 0)],
    ])
    const hit = pickNearestSatellite(map, { x: 100, y: 100 }, positions, 12)
    expect(hit).toBeNull()
  })

  it('ignores satellites that project off-canvas (back of globe)', () => {
    // Sat 99 projects to (-200, 100) — well past the off-canvas buffer; sat 7
    // at (105, 100). Cursor at (100, 100). Without the off-canvas filter, sat
    // 99's chord-projected position could win; with the filter, sat 7 must.
    const map = makeStubMap(([lng]) => ({ x: lng, y: 100 }))
    const positions = new Map<number, SatPosition>([
      [99, sat(99, -200, 0)],
      [7, sat(7, 105, 0)],
    ])
    const hit = pickNearestSatellite(map, { x: 100, y: 100 }, positions, 12)
    expect(hit?.norad).toBe(7)
  })

  it('returns null on an empty positions map', () => {
    const map = makeStubMap(() => ({ x: 0, y: 0 }))
    const hit = pickNearestSatellite(map, { x: 100, y: 100 }, new Map(), 12)
    expect(hit).toBeNull()
  })

  it('respects a smaller pixel radius', () => {
    const map = makeStubMap(([lng]) => ({ x: lng, y: 100 }))
    const positions = new Map<number, SatPosition>([
      [1, sat(1, 110, 0)], // 10px from cursor
    ])
    expect(pickNearestSatellite(map, { x: 100, y: 100 }, positions, 12)?.norad).toBe(1)
    expect(pickNearestSatellite(map, { x: 100, y: 100 }, positions, 5)).toBeNull()
  })

  it('culls back-of-globe satellites when a camera center is provided', () => {
    // Synthetic projection collapses any (lng, lat) onto the cursor itself —
    // both the front-face and back-face sats are pixel-coincident, so the only
    // way the test can prefer one is via the back-face cull.
    const map = makeStubMap(() => ({ x: 100, y: 100 }))
    const positions = new Map<number, SatPosition>([
      // Camera looks at (0°, 0°). Front sat at (0°, 0°) → dot = +1, kept.
      [1, { norad: 1, name: '1', group: 'iss', lng: 0, lat: 0, altitudeKm: 408 }],
      // Back sat at (180°, 0°) → dot = -1, far below the limb threshold for
      // a 408 km LEO orbit (≈ -0.342). Must be culled.
      [2, { norad: 2, name: '2', group: 'iss', lng: 180, lat: 0, altitudeKm: 408 }],
    ])
    const hit = pickNearestSatellite(
      map,
      { x: 100, y: 100 },
      positions,
      12,
      { lng: 0, lat: 0 },
    )
    expect(hit?.norad).toBe(1)
  })

  it('keeps high-altitude sats just past the geometric horizon', () => {
    // Camera at (0°, 0°). A GEO sat at altitude 35 786 km on the back of the
    // globe (lng = 100°) is still visible above the limb because the visibility
    // cone for that altitude extends to ~171° from camera. Picker must NOT cull.
    const map = makeStubMap(() => ({ x: 100, y: 100 }))
    const positions = new Map<number, SatPosition>([
      [
        42,
        {
          norad: 42,
          name: '42',
          group: 'geo',
          lng: 100,
          lat: 0,
          altitudeKm: 35_786,
        },
      ],
    ])
    const hit = pickNearestSatellite(
      map,
      { x: 100, y: 100 },
      positions,
      12,
      { lng: 0, lat: 0 },
    )
    expect(hit?.norad).toBe(42)
  })

  it('skips back-face cull when no camera center is provided (flat mode)', () => {
    const map = makeStubMap(() => ({ x: 100, y: 100 }))
    const positions = new Map<number, SatPosition>([
      // Without camera center, the back-face sat is eligible and wins by being
      // the only candidate.
      [99, { norad: 99, name: '99', group: 'iss', lng: 180, lat: 0, altitudeKm: 408 }],
    ])
    const hit = pickNearestSatellite(map, { x: 100, y: 100 }, positions, 12)
    expect(hit?.norad).toBe(99)
  })

  it('applies altitude radial offset for high-altitude sats under globe', () => {
    // Stub projection: (lng, lat) → (lng, 100). Sub-point of GEO sat at lng=10
    // would land at (10, 100). Camera center (0, 0) → (0, 100). r ≈ 6.61, so
    // the rendered dot is offset to (0 + 6.61 × 10, 100) = (66.1, 100).
    const map = makeStubMap(([lng]) => ({ x: lng, y: 100 }))
    const positions = new Map<number, SatPosition>([
      [42, { norad: 42, name: '42', group: 'geo', lng: 10, lat: 0, altitudeKm: 35_786 }],
    ])

    // Cursor at the *sub-point* would have hit before the fix; with altitude
    // offset the rendered dot is ~56 px away and there must be no hit.
    expect(
      pickNearestSatellite(map, { x: 10, y: 100 }, positions, 22, { lng: 0, lat: 0 }),
    ).toBeNull()

    // Cursor at the offset-corrected position — hit.
    expect(
      pickNearestSatellite(map, { x: 66, y: 100 }, positions, 22, {
        lng: 0,
        lat: 0,
      })?.norad,
    ).toBe(42)
  })

  it('leaves low-altitude sats almost unchanged by the altitude offset', () => {
    // ISS at 408 km has r ≈ 1.064. Sub-point (10, 100) → offset (10.64, 100).
    // Cursor at the sub-point should still hit comfortably within 22 px.
    const map = makeStubMap(([lng]) => ({ x: lng, y: 100 }))
    const positions = new Map<number, SatPosition>([
      [
        25_544,
        { norad: 25_544, name: '25544', group: 'iss', lng: 10, lat: 0, altitudeKm: 408 },
      ],
    ])
    expect(
      pickNearestSatellite(map, { x: 10, y: 100 }, positions, 22, { lng: 0, lat: 0 })
        ?.norad,
    ).toBe(25_544)
  })
})
