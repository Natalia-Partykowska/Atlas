import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SatTLEEntry } from './satellites'

const ORIGINAL_FETCH = globalThis.fetch

const ISS: SatTLEEntry = {
  name: 'ISS (ZARYA)',
  group: 'iss',
  tle1: '1 25544U 98067A   26076.83874734  .00009567  00000+0  18567-3 0  9991',
  tle2: '2 25544  51.6336  32.0723 0006231 202.9067 157.1644 15.48349303557590',
}
const GPS: SatTLEEntry = {
  name: 'GPS BIIR-2  (PRN 13)',
  group: 'gps',
  tle1: '1 24876U 97035A   26076.51782528  .00000062  00000+0  00000+0 0  9990',
  tle2: '2 24876  55.6624 176.7896 0092345  56.4851 304.4122  2.00563268209447',
}

function jsonResponse(payload: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 503, json: async () => payload } as unknown as Response
}

// The loader caches at module scope, so each test gets a fresh module.
beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
})

describe('noradFromTLELine1', () => {
  it('reads the catalog number from columns 3–7', async () => {
    const { noradFromTLELine1 } = await import('./bundledSatellites')
    expect(noradFromTLELine1(ISS.tle1)).toBe(25544)
    expect(noradFromTLELine1('1 00005U 58002B   26076.00000000')).toBe(5)
  })

  it('returns null for a line it cannot read', async () => {
    const { noradFromTLELine1 } = await import('./bundledSatellites')
    expect(noradFromTLELine1('')).toBeNull()
    expect(noradFromTLELine1('1 A1234U 26001A')).toBeNull()
  })
})

describe('loadBundledSatellites', () => {
  it('fetches the bundled file once and reuses it', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse([ISS, GPS]))
    globalThis.fetch = fetchSpy as typeof fetch
    const { loadBundledSatellites } = await import('./bundledSatellites')

    const [a, b] = await Promise.all([loadBundledSatellites(), loadBundledSatellites()])
    const c = await loadBundledSatellites()

    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(fetchSpy.mock.calls[0][0]).toBe('/data/satellites.json')
    expect(a).toEqual([ISS, GPS])
    expect(b).toBe(a)
    expect(c).toBe(a)
  })

  it('does not cache a failure, so the next call tries again', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(null, false))
      .mockResolvedValueOnce(jsonResponse([ISS]))
    globalThis.fetch = fetchSpy as typeof fetch
    const { loadBundledSatellites } = await import('./bundledSatellites')

    await expect(loadBundledSatellites()).rejects.toThrow('503')
    await expect(loadBundledSatellites()).resolves.toEqual([ISS])
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})

describe('findBundledTLE', () => {
  it('returns the TLE and group of a bundled satellite by NORAD number', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse([ISS, GPS])) as typeof fetch
    const { findBundledTLE } = await import('./bundledSatellites')

    await expect(findBundledTLE(24876)).resolves.toEqual({
      name: GPS.name,
      tle1: GPS.tle1,
      tle2: GPS.tle2,
      group: 'gps',
    })
  })

  it('returns null for a satellite that is not bundled', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse([ISS])) as typeof fetch
    const { findBundledTLE } = await import('./bundledSatellites')

    await expect(findBundledTLE(44713)).resolves.toBeNull()
  })

  it('returns null when the bundled file cannot be loaded', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as typeof fetch
    const { findBundledTLE } = await import('./bundledSatellites')

    await expect(findBundledTLE(25544)).resolves.toBeNull()
  })
})
