import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ORIGINAL_FETCH = globalThis.fetch

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
})

beforeEach(() => {
  vi.resetModules()
})

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as unknown as Response
}

const ISS_TLE = {
  name: 'ISS (ZARYA)',
  tle1: '1 25544U 98067A   26076.83874734  .00009567  00000+0  18567-3 0  9991',
  tle2: '2 25544  51.6336  32.0723 0006231 202.9067 157.1644 15.48349303557590',
}

describe('fetchSatelliteTLE', () => {
  it('fetches and returns the TLE payload', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(200, ISS_TLE)) as typeof fetch
    const { fetchSatelliteTLE } = await import('./satelliteTLE')

    const tle = await fetchSatelliteTLE('http://localhost:8080', 25544)
    expect(tle).toEqual(ISS_TLE)
  })

  it('caches successful responses (no second fetch)', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(200, ISS_TLE))
    globalThis.fetch = fetchSpy as typeof fetch
    const { fetchSatelliteTLE } = await import('./satelliteTLE')

    const a = await fetchSatelliteTLE('http://localhost:8080', 25544)
    const b = await fetchSatelliteTLE('http://localhost:8080', 25544)
    expect(a).toBe(b)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('rejects on 404', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(404, {})) as typeof fetch
    const { fetchSatelliteTLE } = await import('./satelliteTLE')

    await expect(fetchSatelliteTLE('http://localhost:8080', 999_999_999)).rejects.toThrow(
      /TLE not found/i,
    )
  })

  it('dedupes concurrent calls for the same NORAD', async () => {
    let resolveFetch!: (r: Response) => void
    const inFlight = new Promise<Response>((resolve) => {
      resolveFetch = resolve
    })
    const fetchSpy = vi.fn(() => inFlight)
    globalThis.fetch = fetchSpy as typeof fetch
    const { fetchSatelliteTLE } = await import('./satelliteTLE')

    const p1 = fetchSatelliteTLE('http://localhost:8080', 25544)
    const p2 = fetchSatelliteTLE('http://localhost:8080', 25544)

    expect(fetchSpy).toHaveBeenCalledTimes(1)

    resolveFetch(jsonResponse(200, ISS_TLE))
    const [a, b] = await Promise.all([p1, p2])
    expect(a).toBe(b)
  })

  it('does not dedupe across different NORADs', async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      const norad = Number(url.match(/\/sat\/(\d+)\/tle/)?.[1])
      return jsonResponse(200, { ...ISS_TLE, name: `SAT-${norad}` })
    })
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const { fetchSatelliteTLE } = await import('./satelliteTLE')

    const [a, b] = await Promise.all([
      fetchSatelliteTLE('http://localhost:8080', 1),
      fetchSatelliteTLE('http://localhost:8080', 2),
    ])
    expect(a.name).toBe('SAT-1')
    expect(b.name).toBe('SAT-2')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})
