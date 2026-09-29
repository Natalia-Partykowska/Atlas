import { useEffect, useMemo, useRef, useState } from 'react'
import {
  twoline2satrec,
  propagate,
  gstime,
  eciToGeodetic,
  degreesLat,
  degreesLong,
} from 'satellite.js'
import type { SatRec } from 'satellite.js'
import { useAtlasStore } from '@/stores/useAtlasStore'
import { fetchSatelliteTLE } from '@/lib/satelliteTLE'
import type { SatelliteTLE } from '@/lib/satelliteTLE'
import { findBundledTLE } from '@/lib/bundledSatellites'
import { SATELLITE_GROUPS } from '@/lib/satellites'
import { speakSatellite, stopSatelliteVoice } from '@/lib/satelliteVoice'
import { SpeakerIcon, VoiceFooter } from './VoiceControls'
import {
  periodMinutes,
  inclinationDegrees,
  apsidesKm,
  velocityKmS,
} from '@/lib/satelliteOrbital'

const DRAWER_WIDTH_PX = 380
const TRANSITION_MS = 250

interface LiveState {
  lat: number
  lng: number
  altKm: number
  vKms: number
}

// The server's TLE is current. The bundled one is months old and only stands
// in while the server can't be reached.
type TleSource = 'server' | 'bundled'

interface TleError {
  message: string
  /** The server couldn't be reached and the satellite isn't bundled. */
  needsLiveFeed: boolean
}

async function resolveTLE(norad: number): Promise<{ tle: SatelliteTLE; source: TleSource }> {
  const httpBase = import.meta.env.VITE_ORBIT_HTTP_URL
  try {
    if (!httpBase) throw new Error('TLE source unavailable')
    return { tle: await fetchSatelliteTLE(httpBase, norad), source: 'server' }
  } catch (err) {
    const bundled = await findBundledTLE(norad)
    if (bundled) return { tle: bundled, source: 'bundled' }
    throw err
  }
}

export default function SatelliteInfoPanel() {
  const selectedSatellite = useAtlasStore((s) => s.selectedSatellite)
  const setSelectedSatellite = useAtlasStore((s) => s.setSelectedSatellite)
  const satellitesVisible = useAtlasStore((s) => s.satellitesVisible)
  const globeMode = useAtlasStore((s) => s.globeMode)
  const satelliteCatalog = useAtlasStore((s) => s.satelliteCatalog)
  const feedLive = useAtlasStore((s) => s.satelliteFeed.status === 'live')

  const isOpen = selectedSatellite !== null && satellitesVisible && globeMode
  const norad = selectedSatellite?.norad ?? null

  const [tle, setTle] = useState<SatelliteTLE | null>(null)
  const [tleLoading, setTleLoading] = useState(false)
  const [tleError, setTleError] = useState<TleError | null>(null)
  const [live, setLive] = useState<LiveState | null>(null)
  const tleSourceRef = useRef<TleSource | null>(null)
  const [reloadTle, setReloadTle] = useState(0)

  // Resolve the TLE when the selection changes: the server first, then the
  // bundled satellites when the server can't be reached.
  useEffect(() => {
    tleSourceRef.current = null
    if (!isOpen || norad === null) {
      setTle(null)
      setTleLoading(false)
      setTleError(null)
      setLive(null)
      return
    }
    let cancelled = false
    setTle(null)
    setLive(null)
    setTleError(null)
    setTleLoading(true)
    resolveTLE(norad)
      .then(({ tle: t, source }) => {
        if (cancelled) return
        tleSourceRef.current = source
        setTle(t)
      })
      .catch((err) => {
        if (cancelled) return
        // Without the live feed the server's error is just "unreachable";
        // say what's actually missing instead.
        const needsLiveFeed = useAtlasStore.getState().satelliteFeed.status !== 'live'
        setTleError({ message: String(err?.message ?? err), needsLiveFeed })
      })
      .finally(() => {
        if (!cancelled) setTleLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [isOpen, norad, reloadTle])

  // When the live feed comes back, swap a bundled (or missing) TLE for the
  // server's current one. Runs only on that change, so opening the drawer
  // doesn't fetch twice.
  useEffect(() => {
    if (feedLive && isOpen && tleSourceRef.current !== 'server') setReloadTle((n) => n + 1)
  }, [feedLive]) // isOpen deliberately left out: see above

  const satrec = useMemo<SatRec | null>(() => {
    if (!tle) return null
    try {
      return twoline2satrec(tle.tle1, tle.tle2)
    } catch {
      return null
    }
  }, [tle])

  // 1 Hz live position + velocity tick
  useEffect(() => {
    if (!isOpen || !satrec) return
    const tick = () => {
      const now = new Date()
      const pv = propagate(satrec, now)
      if (!pv) return
      const pos = pv.position
      const vel = pv.velocity
      if (typeof pos === 'boolean' || !pos) return
      if (typeof vel === 'boolean' || !vel) return
      const gmst = gstime(now)
      const geodetic = eciToGeodetic(pos, gmst)
      const lat = degreesLat(geodetic.latitude)
      const lng = degreesLong(geodetic.longitude)
      const altKm = geodetic.height
      const vKms = velocityKmS(vel)
      if (
        Number.isFinite(lat) &&
        Number.isFinite(lng) &&
        Number.isFinite(altKm) &&
        Number.isFinite(vKms)
      ) {
        setLive({ lat, lng, altKm, vKms })
      }
    }
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [isOpen, satrec])

  // Closing the drawer cuts off a name mid-sentence rather than letting it
  // play over an empty globe. Opening it (a satellite picked on the globe)
  // cuts off a conjunction sentence that's still playing; with names on, the
  // click has already replaced it, so that's a no-op.
  useEffect(() => {
    stopSatelliteVoice(isOpen ? 'conjunction' : 'satellite')
  }, [isOpen])

  // Escape closes
  useEffect(() => {
    if (!isOpen) return
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedSatellite(null)
    }
    window.addEventListener('keydown', handle)
    return () => window.removeEventListener('keydown', handle)
  }, [isOpen, setSelectedSatellite])

  const catEntry = norad !== null ? satelliteCatalog?.get(norad) : null
  const spokenName = catEntry?.name ?? tle?.name ?? null
  const titleName = spokenName ?? (norad !== null ? `NORAD #${norad}` : '')
  const group = catEntry?.group
  const intlDesignator = catEntry?.intlDesignator
  const groupColor = group ? SATELLITE_GROUPS[group].color : '#6B7280'

  const apsides = useMemo(() => (satrec ? apsidesKm(satrec) : null), [satrec])

  return (
    <aside
      aria-label="Satellite details"
      className={[
        'fixed top-0 right-0 h-full z-40 flex flex-col',
        'bg-[#0B1220]/70 backdrop-blur-xl border-l border-white/[0.08]',
        'transition-transform ease-out',
        'shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_25px_50px_-12px_rgba(0,0,0,0.5)]',
        isOpen ? 'translate-x-0' : 'translate-x-full pointer-events-none',
      ].join(' ')}
      style={{ width: `${DRAWER_WIDTH_PX}px`, transitionDuration: `${TRANSITION_MS}ms` }}
    >
      <header className="px-4 py-3 border-b border-white/10 flex items-center gap-2">
        <h2 className="text-white/90 text-sm font-medium flex-1 truncate">
          {titleName}
        </h2>
        {spokenName && (
          // Replays even when announcements are off — it's an explicit ask.
          <button
            onClick={() => void speakSatellite(spokenName)}
            aria-label="Say satellite name"
            title="Say name"
            className="text-white/40 hover:text-white/80 transition-colors p-1 -m-1"
          >
            <SpeakerIcon />
          </button>
        )}
        <button
          onClick={() => setSelectedSatellite(null)}
          aria-label="Close satellite panel"
          className="text-white/40 hover:text-white/80 transition-colors p-1 -m-1"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M4 4l8 8M12 4l-8 8"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </header>

      <div className="flex-1 overflow-y-auto">
        <section className="px-4 py-3 border-b border-white/5">
          <div className="text-white/40 text-[10px] uppercase tracking-wider mb-2">
            Identity
          </div>
          <div className="flex items-center gap-2 text-sm">
            <span
              className="inline-block w-2 h-2 rounded-full"
              style={{ background: groupColor }}
              aria-hidden
            />
            <span className="text-white/85 capitalize">{group ?? 'Unknown group'}</span>
          </div>
          <div className="mt-1 text-xs text-white/55 font-mono tabular-nums">
            NORAD #{norad}
            {intlDesignator ? <> · {intlDesignator}</> : null}
          </div>
        </section>

        <section className="px-4 py-3 border-b border-white/5">
          <div className="text-white/40 text-[10px] uppercase tracking-wider mb-2">
            Live position
          </div>
          {tleLoading ? (
            <p className="text-white/50 text-xs flex items-center gap-2">
              <span
                aria-hidden
                className="inline-block w-3 h-3 rounded-full border-2 border-white/30 border-t-white/80 animate-spin"
              />
              Loading orbit…
            </p>
          ) : tleError?.needsLiveFeed ? (
            <p className="text-white/40 text-xs">Orbit data needs the live feed.</p>
          ) : tleError ? (
            <p className="text-red-300/80 text-xs">{tleError.message}</p>
          ) : live ? (
            <div className="text-xs text-white/65 tabular-nums space-y-1">
              <div className="flex justify-between">
                <span>Latitude</span>
                <span className="text-white/90 font-mono">{live.lat.toFixed(2)}°</span>
              </div>
              <div className="flex justify-between">
                <span>Longitude</span>
                <span className="text-white/90 font-mono">{live.lng.toFixed(2)}°</span>
              </div>
              <div className="flex justify-between">
                <span>Altitude</span>
                <span className="text-white/90 font-mono">{live.altKm.toFixed(0)} km</span>
              </div>
            </div>
          ) : (
            <p className="text-white/30 text-xs">—</p>
          )}
        </section>

        <section className="px-4 py-3 border-b border-white/5">
          <div className="text-white/40 text-[10px] uppercase tracking-wider mb-2">
            Velocity
          </div>
          {live ? (
            <div className="text-sm text-white/90 font-mono tabular-nums">
              {live.vKms.toFixed(2)}{' '}
              <span className="text-white/45 text-xs">km/s</span>
            </div>
          ) : (
            <p className="text-white/30 text-xs">—</p>
          )}
        </section>

        <section className="px-4 py-3">
          <div className="text-white/40 text-[10px] uppercase tracking-wider mb-2">
            Orbital elements
          </div>
          {satrec && apsides ? (
            <div className="text-xs text-white/65 tabular-nums space-y-1">
              <div className="flex justify-between">
                <span>Period</span>
                <span className="text-white/90 font-mono">
                  {periodMinutes(satrec.no).toFixed(1)} min
                </span>
              </div>
              <div className="flex justify-between">
                <span>Inclination</span>
                <span className="text-white/90 font-mono">
                  {inclinationDegrees(satrec.inclo).toFixed(2)}°
                </span>
              </div>
              <div className="flex justify-between">
                <span>Perigee</span>
                <span className="text-white/90 font-mono">{apsides.perigeeKm.toFixed(0)} km</span>
              </div>
              <div className="flex justify-between">
                <span>Apogee</span>
                <span className="text-white/90 font-mono">{apsides.apogeeKm.toFixed(0)} km</span>
              </div>
            </div>
          ) : (
            <p className="text-white/30 text-xs">—</p>
          )}
        </section>
      </div>

      <VoiceFooter />
    </aside>
  )
}
