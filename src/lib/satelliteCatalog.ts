import type { SatGroup } from './satellites'

export interface SatelliteCatalogEntry {
  name: string
  group: SatGroup
  intlDesignator: string
}

let inflight: Promise<Map<number, SatelliteCatalogEntry>> | null = null

export function fetchSatelliteCatalog(
  baseUrl: string,
): Promise<Map<number, SatelliteCatalogEntry>> {
  if (inflight) return inflight

  const url = `${baseUrl.replace(/\/$/, '')}/catalog`
  const p: Promise<Map<number, SatelliteCatalogEntry>> = fetch(url, {
    credentials: 'omit',
  })
    .then(async (res) => {
      if (!res.ok) throw new Error(`/catalog ${res.status}`)
      const obj = (await res.json()) as Record<string, SatelliteCatalogEntry>
      const map = new Map<number, SatelliteCatalogEntry>()
      for (const [k, v] of Object.entries(obj)) {
        map.set(Number(k), v)
      }
      return map
    })
    .finally(() => {
      if (inflight === p) inflight = null
    })

  inflight = p
  return p
}
