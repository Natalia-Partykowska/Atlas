import { useAtlasStore } from '@/stores/useAtlasStore'
import type { SatelliteFeedStatus } from '@/lib/satelliteFeed'

interface SatelliteLine {
  text: string
  /** The bundled satellites, or a dropped stream's frozen last frame. */
  degraded: boolean
}

// The satellite part of the status line says where the dots on the globe come
// from. The bundled satellites are never called "Live".
function satelliteLine(status: SatelliteFeedStatus, count: number): SatelliteLine | null {
  const sats = `${count.toLocaleString()} sats`
  switch (status) {
    case 'connecting':
      return { text: 'Connecting…', degraded: false }
    case 'live':
      return count > 0 ? { text: `Live · ${sats}`, degraded: false } : null
    case 'reconnecting':
      return { text: count > 0 ? `Reconnecting · ${sats}` : 'Reconnecting', degraded: true }
    case 'limited':
      return { text: count > 0 ? `Limited · ${sats}` : 'Limited', degraded: true }
    case 'off':
      return null
  }
}

// Top-left identity + live telemetry strip. Always renders the brand mark +
// wordmark; the status line below appears only when something is flowing
// (satellite positions, aurora Kp). The satellite part turns amber when the
// globe isn't showing the live feed.
//
// Placement is `pointer-events-none` so the brand never intercepts map drags.
export default function BrandStrip() {
  const satellitesVisible = useAtlasStore((s) => s.satellitesVisible)
  const satelliteCount = useAtlasStore((s) => s.satelliteCount)
  const feedStatus = useAtlasStore((s) => s.satelliteFeed.status)
  const auroraVisible = useAtlasStore((s) => s.auroraVisible)
  const auroraKp = useAtlasStore((s) => s.auroraKp)
  const auroraDataUnavailable = useAtlasStore((s) => s.auroraDataUnavailable)

  const sats = satellitesVisible ? satelliteLine(feedStatus, satelliteCount) : null
  const kpLive = auroraVisible && !auroraDataUnavailable
  const hasStatus = sats !== null || kpLive

  return (
    <div className="fixed top-4 left-4 z-40 select-none pointer-events-none [&_*]:pointer-events-none">
      {/* Brand mark + wordmark. The first-load splash in index.html redraws
          this mark (with an orbiting satellite), and public/favicon.svg (plus
          its PNG renders) draws it on a dark tile — keep the geometry in sync. */}
      <div className="flex items-center gap-2 text-white/90">
        <svg
          width="22"
          height="22"
          viewBox="0 0 28 28"
          fill="none"
          aria-hidden="true"
        >
          <ellipse
            cx="14"
            cy="14"
            rx="12"
            ry="4"
            stroke="currentColor"
            strokeWidth="1.5"
            transform="rotate(-22 14 14)"
            opacity="0.7"
          />
          <circle cx="14" cy="14" r="3" fill="currentColor" opacity="0.9" />
          <circle cx="25" cy="10.6" r="1.6" fill="currentColor" />
        </svg>
        <span className="text-[13px] font-semibold tracking-[0.18em] uppercase">
          Atlas
        </span>
      </div>

      {/* Status line — only when something is flowing */}
      {hasStatus && (
        <div
          data-testid="brand-status"
          data-feed={sats ? (sats.degraded ? 'degraded' : feedStatus) : undefined}
          className="ml-[30px] mt-1 flex items-center gap-1.5 text-[10px] font-mono tabular-nums uppercase tracking-wider text-white/55"
        >
          <span
            aria-hidden="true"
            className={[
              'w-1.5 h-1.5 rounded-full',
              sats?.degraded ? 'bg-amber-400' : 'bg-white/80 animate-pulse',
            ].join(' ')}
          />
          <span>
            {sats && <span className={sats.degraded ? 'text-amber-300/90' : undefined}>{sats.text}</span>}
            {sats && kpLive && ' · '}
            {kpLive && `Kp ${auroraKp.toFixed(1)}`}
          </span>
        </div>
      )}
    </div>
  )
}
