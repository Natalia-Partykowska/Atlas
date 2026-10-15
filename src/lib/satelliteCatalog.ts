import type { SatGroup } from './satellites'

export interface SatelliteCatalogEntry {
  name: string
  group: SatGroup
  intlDesignator: string
}

/** `/catalog`, or `/catalog?v=<version>` when the server's catalog version is
 *  known: each version gets its own URL, so the browser's 1-hour cache can't
 *  hand back the names of an older catalog. The server ignores the query. */
export function satelliteCatalogUrl(baseUrl: string, version: number | null = null): string {
  const url = `${baseUrl.replace(/\/$/, '')}/catalog`
  return version === null ? url : `${url}?v=${version}`
}

const inflight = new Map<string, Promise<Map<number, SatelliteCatalogEntry>>>()

export function fetchSatelliteCatalog(
  baseUrl: string,
  version: number | null = null,
): Promise<Map<number, SatelliteCatalogEntry>> {
  const url = satelliteCatalogUrl(baseUrl, version)
  const pending = inflight.get(url)
  if (pending) return pending

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
      if (inflight.get(url) === p) inflight.delete(url)
    })

  inflight.set(url, p)
  return p
}

/**
 * Whether to load satellite names now. A server that reports its catalog
 * version gets the names for that version, as soon as it says (before the
 * first batch, and while reconnecting). An older server that doesn't is
 * known only once it's live; its names are loaded once.
 */
export function shouldLoadCatalog({
  feedLive,
  statusVersion,
  loadedVersion,
  hasCatalog,
}: {
  feedLive: boolean
  /** The version the server reports, or null (none yet, bundled satellites,
   *  or an older server). */
  statusVersion: number | null
  /** The version the loaded names belong to; null if they came from a server
   *  without versions. */
  loadedVersion: number | null
  hasCatalog: boolean
}): boolean {
  if (statusVersion !== null) return !hasCatalog || loadedVersion !== statusVersion
  return feedLive && !hasCatalog
}
