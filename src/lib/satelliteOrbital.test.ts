import { describe, it, expect } from 'vitest'
import { twoline2satrec } from 'satellite.js'
import {
  periodMinutes,
  inclinationDegrees,
  apsidesKm,
  velocityKmS,
  generateOrbitPoints,
} from './satelliteOrbital'

// Real ISS TLE — same fixture used in satellites.test.ts and the server tests.
const ISS_LINE1 =
  '1 25544U 98067A   26076.83874734  .00009567  00000+0  18567-3 0  9991'
const ISS_LINE2 =
  '2 25544  51.6336  32.0723 0006231 202.9067 157.1644 15.48349303557590'

describe('periodMinutes', () => {
  it('matches ISS-class ~92 minutes', () => {
    const satrec = twoline2satrec(ISS_LINE1, ISS_LINE2)
    expect(periodMinutes(satrec.no)).toBeGreaterThan(85)
    expect(periodMinutes(satrec.no)).toBeLessThan(100)
  })

  it('inverts mean motion: 2π / no', () => {
    expect(periodMinutes(2 * Math.PI)).toBeCloseTo(1)
    expect(periodMinutes(Math.PI)).toBeCloseTo(2)
  })
})

describe('inclinationDegrees', () => {
  it('converts radians to degrees', () => {
    expect(inclinationDegrees(0)).toBe(0)
    expect(inclinationDegrees(Math.PI)).toBeCloseTo(180)
    expect(inclinationDegrees(Math.PI / 2)).toBeCloseTo(90)
  })

  it('matches ISS ~51.64° from real TLE', () => {
    const satrec = twoline2satrec(ISS_LINE1, ISS_LINE2)
    expect(inclinationDegrees(satrec.inclo)).toBeCloseTo(51.6336, 2)
  })
})

describe('apsidesKm', () => {
  it('matches ISS-class ~400 km perigee/apogee', () => {
    const satrec = twoline2satrec(ISS_LINE1, ISS_LINE2)
    const { perigeeKm, apogeeKm } = apsidesKm(satrec)
    expect(perigeeKm).toBeGreaterThan(380)
    expect(perigeeKm).toBeLessThan(440)
    expect(apogeeKm).toBeGreaterThan(perigeeKm)
    expect(apogeeKm - perigeeKm).toBeLessThan(20)
  })
})

describe('velocityKmS', () => {
  it('computes Euclidean magnitude', () => {
    expect(velocityKmS({ x: 3, y: 4, z: 0 })).toBe(5)
    expect(velocityKmS({ x: 0, y: 0, z: 0 })).toBe(0)
  })
})

describe('generateOrbitPoints', () => {
  it('produces ~one full orbit of finite samples', () => {
    const satrec = twoline2satrec(ISS_LINE1, ISS_LINE2)
    const points = generateOrbitPoints(satrec, new Date('2026-03-17T20:00:00Z'))
    expect(points.length).toBeGreaterThan(150)
    expect(points.length).toBeLessThanOrEqual(181)
    for (const p of points) {
      expect(Number.isFinite(p.lng)).toBe(true)
      expect(Number.isFinite(p.lat)).toBe(true)
      expect(Number.isFinite(p.altKm)).toBe(true)
      expect(p.lat).toBeGreaterThanOrEqual(-90)
      expect(p.lat).toBeLessThanOrEqual(90)
    }
  })

  it('respects the samples parameter', () => {
    const satrec = twoline2satrec(ISS_LINE1, ISS_LINE2)
    const points = generateOrbitPoints(satrec, new Date('2026-03-17T20:00:00Z'), 32)
    expect(points.length).toBeGreaterThan(20)
    expect(points.length).toBeLessThanOrEqual(33)
  })

  it('orbit points span the inclination band', () => {
    const satrec = twoline2satrec(ISS_LINE1, ISS_LINE2)
    const points = generateOrbitPoints(satrec, new Date('2026-03-17T20:00:00Z'))
    const lats = points.map((p) => p.lat)
    const max = Math.max(...lats)
    const min = Math.min(...lats)
    // ISS inclination 51.6° → orbit reaches roughly ±51.6° latitude.
    expect(max).toBeGreaterThan(45)
    expect(min).toBeLessThan(-45)
  })

  it('produces a closed loop in current Earth-fixed coordinates', () => {
    // First and last samples are at t=now and t=now+period — same ECI position
    // (orbit periodic), converted with the same gmst(now), so they coincide
    // on Earth-fixed coordinates. SGP4 secular perturbations (J2 nodal
    // regression, argument-of-perigee drift) push the closure off by under
    // half a degree per orbit — still imperceptible in the rendered ring.
    const satrec = twoline2satrec(ISS_LINE1, ISS_LINE2)
    const points = generateOrbitPoints(satrec, new Date('2026-03-17T20:00:00Z'))
    const first = points[0]
    const last = points[points.length - 1]
    expect(Math.abs(last.lat - first.lat)).toBeLessThan(0.5)
    expect(Math.abs(last.lng - first.lng)).toBeLessThan(0.5)
    expect(Math.abs(last.altKm - first.altKm)).toBeLessThan(5)
  })
})
