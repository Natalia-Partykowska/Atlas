import { useEffect, useMemo, useState } from 'react'
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
import { SATELLITE_GROUPS } from '@/lib/satellites'
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

export default function SatelliteInfoPanel() {
  const selectedSatellite = useAtlasStore((s) => s.selectedSatellite)
  const setSelectedSatellite = useAtlasStore((s) => s.setSelectedSatellite)
  const satellitesVisible = useAtlasStore((s) => s.satellitesVisible)
  const globeMode = useAtlasStore((s) => s.globeMode)
  const satelliteCatalog = useAtlasStore((s) => s.satelliteCatalog)

  const isOpen = selectedSatellite !== null && satellitesVisible && globeMode
  const norad = selectedSatellite?.norad ?? null

  const [tle, setTle] = useState<SatelliteTLE | null>(null)
  const [tleLoading, setTleLoading] = useState(false)
  const [tleError, setTleError] = useState<string | null>(null)
  const [live, setLive] = useState<LiveState | null>(null)

  // Fetch TLE when selection changes
  useEffect(() => {
    if (!isOpen || norad === null) {
      setTle(null)
      setTleLoading(false)
      setTleError(null)
      setLive(null)
      return
    }
    const httpBase = import.meta.env.VITE_ORBIT_HTTP_URL
    if (!httpBase) {
      setTleError('TLE source unavailable')
      return
    }
    let cancelled = false
    setTle(null)
    setLive(null)
    setTleError(null)
    setTleLoading(true)
    fetchSatelliteTLE(httpBase, norad)
      .then((t) => {
        if (!cancelled) setTle(t)
      })
      .catch((err) => {
        if (!cancelled) setTleError(String(err?.message ?? err))
      })
      .finally(() => {
        if (!cancelled) setTleLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [isOpen, norad])

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
  const titleName = catEntry?.name ?? tle?.name ?? (norad !== null ? `NORAD #${norad}` : '')
  const group = catEntry?.group
  const intlDesignator = catEntry?.intlDesignator
  const groupColor = group ? SATELLITE_GROUPS[group].color : '#6B7280'

  const apsides = useMemo(() => (satrec ? apsidesKm(satrec) : null), [satrec])

  return (
    <aside
      aria-label="Satellite details"
      className={[
        'fixed top-0 right-0 h-full z-40 flex flex-col',
        'bg-black/60 backdrop-blur-md border-l border-white/10',
        'transition-transform ease-out shadow-2xl',
        isOpen ? 'translate-x-0' : 'translate-x-full pointer-events-none',
      ].join(' ')}
      style={{ width: `${DRAWER_WIDTH_PX}px`, transitionDuration: `${TRANSITION_MS}ms` }}
    >
      <header className="px-4 py-3 border-b border-white/10 flex items-center gap-2">
        <h2 className="text-white/90 text-sm font-medium flex-1 truncate">
          {titleName}
        </h2>
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
          <div className="mt-1 text-xs text-white/55 tabular-nums">
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
          ) : tleError ? (
            <p className="text-red-300/80 text-xs">{tleError}</p>
          ) : live ? (
            <div className="text-xs text-white/65 tabular-nums space-y-1">
              <div className="flex justify-between">
                <span>Latitude</span>
                <span className="text-white/90">{live.lat.toFixed(2)}°</span>
              </div>
              <div className="flex justify-between">
                <span>Longitude</span>
                <span className="text-white/90">{live.lng.toFixed(2)}°</span>
              </div>
              <div className="flex justify-between">
                <span>Altitude</span>
                <span className="text-white/90">{live.altKm.toFixed(0)} km</span>
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
            <div className="text-sm text-white/90 tabular-nums">
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
                <span className="text-white/90">
                  {periodMinutes(satrec.no).toFixed(1)} min
                </span>
              </div>
              <div className="flex justify-between">
                <span>Inclination</span>
                <span className="text-white/90">
                  {inclinationDegrees(satrec.inclo).toFixed(2)}°
                </span>
              </div>
              <div className="flex justify-between">
                <span>Perigee</span>
                <span className="text-white/90">{apsides.perigeeKm.toFixed(0)} km</span>
              </div>
              <div className="flex justify-between">
                <span>Apogee</span>
                <span className="text-white/90">{apsides.apogeeKm.toFixed(0)} km</span>
              </div>
            </div>
          ) : (
            <p className="text-white/30 text-xs">—</p>
          )}
        </section>
      </div>
    </aside>
  )
}
