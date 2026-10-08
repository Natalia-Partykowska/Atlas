import { describe, it, expect } from 'vitest'
import { pickNearestSatellite } from './satellitePicking'
import { createScreenProjector } from './satelliteProjection'
import type { SatPosition } from './satellites'
import { CANVAS, at, makeGlobeCamera, perspectiveOffsetPx } from '@/test/globeCamera'
import type { GlobeCamera } from '@/test/globeCamera'

const W = CANVAS.width
const H = CANVAS.height

function sat(norad: number, lng: number, lat: number, altitudeKm = 550): SatPosition {
  return { norad, name: String(norad), group: 'starlink', lng, lat, altitudeKm }
}

function positionsOf(...sats: SatPosition[]): Map<number, SatPosition> {
  return new Map(sats.map((s) => [s.norad, s]))
}

function drawnAt(cam: GlobeCamera, s: SatPosition) {
  const p = at(createScreenProjector(cam.frame, W, H), s.lng, s.lat, s.altitudeKm)
  if (!p) throw new Error(`satellite ${s.norad} isn't drawn`)
  return p
}

// Longitude (on the equator) at which a satellite is drawn at screen x.
function lngDrawnAtX(cam: GlobeCamera, x: number, altitudeKm: number): number {
  let lo = 0
  let hi = 10
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (drawnAt(cam, sat(0, mid, 0, altitudeKm)).x < x) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

describe('pickNearestSatellite', () => {
  const cam = makeGlobeCamera(4.5, [0, 0])

  it('returns the drawn satellite nearest the pointer', () => {
    const a = sat(1, 1, 0)
    const b = sat(2, 1.3, 0)
    const pa = drawnAt(cam, a)
    const pb = drawnAt(cam, b)
    // Closer to b, with both within the radius.
    const pointer = { x: pa.x + 0.7 * (pb.x - pa.x), y: pa.y }
    expect(pickNearestSatellite(cam.frame, CANVAS, pointer, positionsOf(a, b))?.norad).toBe(2)
    expect(pickNearestSatellite(cam.frame, CANVAS, pa, positionsOf(a, b))?.norad).toBe(1)
  })

  it('returns null when no drawn satellite is within the radius', () => {
    const a = sat(1, 1, 0)
    const p = drawnAt(cam, a)
    expect(pickNearestSatellite(cam.frame, CANVAS, { x: p.x + 30, y: p.y }, positionsOf(a))).toBeNull()
  })

  it('respects the pixel radius', () => {
    const a = sat(1, 1, 0)
    const p = drawnAt(cam, a)
    const pointer = { x: p.x + 10, y: p.y }
    expect(pickNearestSatellite(cam.frame, CANVAS, pointer, positionsOf(a), 12)?.norad).toBe(1)
    expect(pickNearestSatellite(cam.frame, CANVAS, pointer, positionsOf(a), 5)).toBeNull()
  })

  it('returns null on an empty positions map', () => {
    expect(pickNearestSatellite(cam.frame, CANVAS, { x: W / 2, y: H / 2 }, new Map())).toBeNull()
  })

  it('returns null before the first frame has been drawn', () => {
    const a = sat(1, 0, 0)
    expect(pickNearestSatellite(null, CANVAS, { x: W / 2, y: H / 2 }, positionsOf(a))).toBeNull()
  })

  it('zoomed in, picks the dot under the pointer, not the neighbour the distant-camera guess put there', () => {
    // Regression: the old picker placed satellite a at `r × ground offset`
    // (~140 px right of centre at zoom 6.5), but it's drawn ~264 px right.
    // A pointer on satellite b, drawn 5 px from that guess, used to pick a.
    const zoomed = makeGlobeCamera(6.5, [0, 0])
    const a = sat(1, 1, 0)
    const oldGuessX = W / 2 + (1 + 550 / 6378.137) * perspectiveOffsetPx(zoomed, 1, 0)
    const b = sat(2, lngDrawnAtX(zoomed, oldGuessX + 5, 550), 0)
    const pointer = { x: oldGuessX, y: H / 2 }

    expect(drawnAt(zoomed, a).x - pointer.x).toBeGreaterThan(100)
    expect(pickNearestSatellite(zoomed.frame, CANVAS, pointer, positionsOf(a, b))?.norad).toBe(2)
  })

  it('picks a GEO satellite drawn beside the globe', () => {
    // Zoomed out to 1, a GEO satellite on the far side (120° from the view
    // centre) hangs in space well clear of the globe's edge and is drawn.
    const zoomedOut = makeGlobeCamera(1, [0, 0])
    const geo = { ...sat(1, 120, 0, 35_786), group: 'geo' as const }
    const p = drawnAt(zoomedOut, geo)
    expect(p.x - W / 2).toBeGreaterThan(400) // the globe itself is ~146 px in radius here
    expect(pickNearestSatellite(zoomedOut.frame, CANVAS, p, positionsOf(geo))?.norad).toBe(1)
  })

  it('never picks a satellite that isn’t drawn (GEO behind the camera at the default zoom)', () => {
    // Regression: at zoom 2.5 the camera is closer than GEO, so a near-side
    // GEO satellite isn't drawn, but the old picker put it ~265 px right of
    // centre and it won picks there.
    const defaultZoom = makeGlobeCamera(2.5, [0, 0])
    const geo = { ...sat(1, 5, 0, 35_786), group: 'geo' as const }
    const oldGuessX = W / 2 + (1 + 35_786 / 6378.137) * perspectiveOffsetPx(defaultZoom, 5, 0)
    expect(oldGuessX).toBeLessThan(W)
    expect(pickNearestSatellite(defaultZoom.frame, CANVAS, { x: oldGuessX, y: H / 2 }, positionsOf(geo))).toBeNull()
  })
})
