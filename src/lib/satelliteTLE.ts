export interface SatelliteTLE {
  name: string
  tle1: string
  tle2: string
}

const cache = new Map<number, SatelliteTLE>()
const inflight = new Map<number, Promise<SatelliteTLE>>()

export function fetchSatelliteTLE(
  baseUrl: string,
  norad: number,
): Promise<SatelliteTLE> {
  const cached = cache.get(norad)
  if (cached) return Promise.resolve(cached)

  const existing = inflight.get(norad)
  if (existing) return existing

  const url = `${baseUrl.replace(/\/$/, '')}/sat/${norad}/tle`
  const p = fetch(url, { credentials: 'omit' })
    .then(async (res) => {
      if (res.status === 404) throw new Error(`TLE not found for NORAD ${norad}`)
      if (!res.ok) throw new Error(`/sat/${norad}/tle ${res.status}`)
      const tle = (await res.json()) as SatelliteTLE
      cache.set(norad, tle)
      return tle
    })
    .finally(() => {
      inflight.delete(norad)
    })

  inflight.set(norad, p)
  return p
}
