import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ORIGINAL_FETCH = globalThis.fetch

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
})

beforeEach(() => {
  vi.resetModules()
})

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as unknown as Response
}

describe('fetchSatelliteCatalog', () => {
  it('parses the response into a Map keyed by NORAD number', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        '25544': { name: 'ISS (ZARYA)', group: 'iss', intlDesignator: '98067A' },
        '36086': { name: 'POISK', group: 'station', intlDesignator: '09060A' },
      }),
    ) as typeof fetch
    const { fetchSatelliteCatalog } = await import('./satelliteCatalog')

    const map = await fetchSatelliteCatalog('http://localhost:8080')

    expect(map.get(25544)).toEqual({
      name: 'ISS (ZARYA)',
      group: 'iss',
      intlDesignator: '98067A',
    })
    expect(map.get(36086)?.group).toBe('station')
    expect(map.size).toBe(2)
  })

  it('strips a trailing slash from baseUrl when constructing /catalog', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({}))
    globalThis.fetch = fetchSpy as typeof fetch
    const { fetchSatelliteCatalog } = await import('./satelliteCatalog')

    await fetchSatelliteCatalog('http://localhost:8080/')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy.mock.calls[0][0]).toBe('http://localhost:8080/catalog')
  })

  it('dedupes concurrent calls into a single fetch', async () => {
    let resolveFetch!: (r: Response) => void
    const inFlight = new Promise<Response>((resolve) => {
      resolveFetch = resolve
    })
    const fetchSpy = vi.fn(() => inFlight)
    globalThis.fetch = fetchSpy as typeof fetch
    const { fetchSatelliteCatalog } = await import('./satelliteCatalog')

    const p1 = fetchSatelliteCatalog('http://localhost:8080')
    const p2 = fetchSatelliteCatalog('http://localhost:8080')

    expect(fetchSpy).toHaveBeenCalledTimes(1)

    resolveFetch(
      jsonResponse({
        '1': { name: 'A', group: 'iss', intlDesignator: 'X' },
      }),
    )
    const [m1, m2] = await Promise.all([p1, p2])

    expect(m1).toBe(m2)
    expect(m1.get(1)?.name).toBe('A')
  })

  it('throws on non-2xx response', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    })) as unknown as typeof fetch
    const { fetchSatelliteCatalog } = await import('./satelliteCatalog')

    await expect(fetchSatelliteCatalog('http://localhost:8080')).rejects.toThrow()
  })
})
