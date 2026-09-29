import type { SatTLEEntry } from './satellites'
import type { SatelliteTLE } from './satelliteTLE'

// The ~262 satellites bundled with the app (ISS, stations, GPS, a Starlink
// sample). They drive the globe when the orbit server can't be reached, and
// their TLEs let the satellite drawer show orbital data without the server.
// Loaded once per visit; a failed load isn't cached, so the next call retries.

export const BUNDLED_SATELLITES_URL = '/data/satellites.json'

let entries: SatTLEEntry[] | null = null
let inflight: Promise<SatTLEEntry[]> | null = null
let byNorad: Map<number, SatelliteTLE> | null = null

/** The NORAD catalog number in columns 3–7 of TLE line 1, or null. */
export function noradFromTLELine1(line1: string): number | null {
  const field = line1.slice(2, 7).trim()
  return /^\d+$/.test(field) ? Number(field) : null
}

export function loadBundledSatellites(): Promise<SatTLEEntry[]> {
  if (entries) return Promise.resolve(entries)
  if (inflight) return inflight

  const p: Promise<SatTLEEntry[]> = fetch(BUNDLED_SATELLITES_URL)
    .then(async (res) => {
      if (!res.ok) throw new Error(`${BUNDLED_SATELLITES_URL} ${res.status}`)
      entries = (await res.json()) as SatTLEEntry[]
      return entries
    })
    .finally(() => {
      if (inflight === p) inflight = null
    })

  inflight = p
  return p
}

/** The bundled TLE for `norad`, or null when it isn't bundled or the file
 *  can't be loaded. */
export async function findBundledTLE(norad: number): Promise<SatelliteTLE | null> {
  let list: SatTLEEntry[]
  try {
    list = await loadBundledSatellites()
  } catch {
    return null
  }
  if (!byNorad) {
    byNorad = new Map()
    for (const e of list) {
      const n = noradFromTLELine1(e.tle1)
      if (n !== null) byNorad.set(n, { name: e.name, tle1: e.tle1, tle2: e.tle2 })
    }
  }
  return byNorad.get(norad) ?? null
}
