import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shouldLoadCatalog } from './satelliteCatalog'

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

  it('asks for /catalog?v=<version> when the version is known', async () => {
    const fetchSpy = vi.fn(async (_url: string) => jsonResponse({}))
    globalThis.fetch = fetchSpy as typeof fetch
    const { fetchSatelliteCatalog } = await import('./satelliteCatalog')

    await fetchSatelliteCatalog('http://localhost:8080/', 1_791_763_200_000)

    expect(fetchSpy.mock.calls[0][0]).toBe('http://localhost:8080/catalog?v=1791763200000')
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

  it('dedupes per URL: another version is fetched separately', async () => {
    const fetchSpy = vi.fn((_url: string) => new Promise<Response>(() => {}))
    globalThis.fetch = fetchSpy as typeof fetch
    const { fetchSatelliteCatalog } = await import('./satelliteCatalog')

    void fetchSatelliteCatalog('http://localhost:8080', 1)
    void fetchSatelliteCatalog('http://localhost:8080', 1)
    void fetchSatelliteCatalog('http://localhost:8080', 2)

    expect(fetchSpy.mock.calls.map((c) => c[0])).toEqual([
      'http://localhost:8080/catalog?v=1',
      'http://localhost:8080/catalog?v=2',
    ])
  })

  it('fetches again after a failed fetch', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }))
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const { fetchSatelliteCatalog } = await import('./satelliteCatalog')

    await expect(fetchSatelliteCatalog('http://localhost:8080', 2)).rejects.toThrow()
    await expect(fetchSatelliteCatalog('http://localhost:8080', 2)).rejects.toThrow()

    expect(fetchSpy).toHaveBeenCalledTimes(2)
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

describe('shouldLoadCatalog', () => {
  it.each([
    // feedLive, statusVersion, loadedVersion, hasCatalog → load?
    [false, null, null, false, false, 'nothing known yet: wait'],
    [false, 5, null, false, true, 'the status arrived before the first batch'],
    [true, 5, null, false, true, 'live with a version and no names yet'],
    [true, 5, 5, true, false, 'the names are for this version'],
    [true, 6, 5, true, true, 'the catalog changed'],
    [false, 6, 5, true, true, 'it changed and the stream is reconnecting'],
    [true, 5, null, true, true, 'the names came from a server without versions'],
    [true, null, null, false, true, 'a server without versions: load once, when live'],
    [true, null, null, true, false, 'a server without versions: already loaded'],
    [false, null, 5, true, false, 'bundled satellites: keep the names'],
  ] as const)(
    'live=%s status=%s loaded=%s hasCatalog=%s → %s (%s)',
    (feedLive, statusVersion, loadedVersion, hasCatalog, expected, _why) => {
      expect(shouldLoadCatalog({ feedLive, statusVersion, loadedVersion, hasCatalog })).toBe(
        expected,
      )
    },
  )
})
