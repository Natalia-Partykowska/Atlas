import { describe, it, expect } from 'vitest'
import { createScreenProjector, recoverCameraPosition } from './satelliteProjection'
import { CANVAS, at, makeGlobeCamera, perspectiveOffsetPx } from '@/test/globeCamera'

const W = CANVAS.width
const H = CANVAS.height
const DEG = Math.PI / 180

describe('createScreenProjector', () => {
  it('puts the view centre at altitude 0 on the canvas centre', () => {
    const cam = makeGlobeCamera(2.5, [30, 40])
    const p = at(createScreenProjector(cam.frame, W, H), 30, 40, 0)
    expect(p?.x).toBeCloseTo(W / 2, 6)
    expect(p?.y).toBeCloseTo(H / 2, 6)
  })

  it('matches the perspective projection for ground points', () => {
    const cam = makeGlobeCamera(2.5, [0, 0])
    const project = createScreenProjector(cam.frame, W, H)
    for (const lng of [5, 20, -12]) {
      const p = at(project, lng, 0, 0)
      expect(p?.x).toBeCloseTo(W / 2 + perspectiveOffsetPx(cam, lng, 0), 6)
      expect(p?.y).toBeCloseTo(H / 2, 6)
    }
    // North is up the screen.
    const north = at(project, 0, 10, 0)
    expect(north?.x).toBeCloseTo(W / 2, 6)
    expect(north?.y).toBeCloseTo(H / 2 - perspectiveOffsetPx(cam, 10, 0), 6)
  })

  it('draws a zoomed-in Starlink satellite where the perspective puts it, not where the r × offset did', () => {
    // Zoom 6.5 puts the camera ~1,170 km above the view centre, so a satellite
    // at 550 km is magnified far more than the old r = 1 + alt/R allowed for.
    const cam = makeGlobeCamera(6.5, [0, 0])
    const p = at(createScreenProjector(cam.frame, W, H), 1, 0, 550)
    const truth = W / 2 + perspectiveOffsetPx(cam, 1, 550)
    const oldGuess = W / 2 + (1 + 550 / 6378.137) * perspectiveOffsetPx(cam, 1, 0)
    expect(Math.abs((p?.x ?? NaN) - truth)).toBeLessThan(0.5)
    expect(Math.abs((p?.x ?? NaN) - oldGuess)).toBeGreaterThan(100)
  })

  it('returns null for a satellite behind the camera', () => {
    // At zoom 2.5 on a 900 px-tall canvas the camera is ~3.9 Earth radii from
    // the centre of the Earth, below GEO (6.6 R): a GEO satellite over the
    // view centre is behind it and isn't drawn.
    const near = makeGlobeCamera(2.5, [0, 0])
    expect(at(createScreenProjector(near.frame, W, H), 0, 0, 35_786)).toBeNull()
    // Zoomed out to 1, the camera is ~9.3 R out and the same satellite is in front of it.
    const far = makeGlobeCamera(1, [0, 0])
    expect(at(createScreenProjector(far.frame, W, H), 0, 0, 35_786)).not.toBeNull()
  })

  it('returns null for a satellite hidden behind the globe, and keeps one just above the horizon', () => {
    // Camera ~3.93 R from the Earth's centre: a 550 km satellite stays in view
    // up to ~98° from the view centre.
    const cam = makeGlobeCamera(2.5, [0, 0])
    const project = createScreenProjector(cam.frame, W, H)
    expect(at(project, 95, 0, 550)).not.toBeNull()
    expect(at(project, 100, 0, 550)).toBeNull()
    expect(at(project, 180, 0, 550)).toBeNull()
  })

  it('projects across the ±180° line', () => {
    const across = at(createScreenProjector(makeGlobeCamera(4.5, [179, 0]).frame, W, H), -179, 0, 550)
    const plain = at(createScreenProjector(makeGlobeCamera(4.5, [0, 0]).frame, W, H), 2, 0, 550)
    expect(across?.x).toBeCloseTo(plain?.x ?? NaN, 6)
    expect(across?.y).toBeCloseTo(plain?.y ?? NaN, 6)
    expect(across!.x).toBeGreaterThan(W / 2)
  })

  it('projects nothing while the map is still turning into the globe', () => {
    const cam = makeGlobeCamera(2.5, [0, 0])
    const project = createScreenProjector({ ...cam.frame, transition: 0.5 }, W, H)
    expect(at(project, 0, 0, 550)).toBeNull()
  })
})

describe('recoverCameraPosition', () => {
  it('finds the camera on the line through the view centre, D + R from the Earth’s centre', () => {
    const cam = makeGlobeCamera(3, [30, 20])
    const eye = recoverCameraPosition(cam.frame.mainMatrix)
    const dist = 1 + cam.cameraToCenterDistance / cam.globeRadiusPx
    const lng = 30 * DEG
    const lat = 20 * DEG
    const expected = [
      Math.sin(lng) * Math.cos(lat) * dist,
      Math.sin(lat) * dist,
      Math.cos(lng) * Math.cos(lat) * dist,
    ]
    expect(eye).not.toBeNull()
    eye!.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 9))
  })

  it('returns null for a matrix that has no inverse', () => {
    expect(recoverCameraPosition(new Float64Array(16))).toBeNull()
  })
})
