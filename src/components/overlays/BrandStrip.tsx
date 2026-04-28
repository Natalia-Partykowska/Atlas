import { useAtlasStore } from '@/stores/useAtlasStore'

// Top-left identity + live telemetry strip. Always renders the brand mark +
// wordmark; the status line below appears only when something live is flowing
// (satellite positions, aurora Kp).
//
// Placement is `pointer-events-none` so the brand never intercepts map drags.
export default function BrandStrip() {
  const satellitesVisible = useAtlasStore((s) => s.satellitesVisible)
  const satelliteCount = useAtlasStore((s) => s.satelliteCount)
  const auroraVisible = useAtlasStore((s) => s.auroraVisible)
  const auroraKp = useAtlasStore((s) => s.auroraKp)
  const auroraDataUnavailable = useAtlasStore((s) => s.auroraDataUnavailable)

  const satsLive = satellitesVisible && satelliteCount > 0
  const kpLive = auroraVisible && !auroraDataUnavailable
  const hasStatus = satsLive || kpLive

  return (
    <div className="fixed top-4 left-4 z-40 select-none pointer-events-none [&_*]:pointer-events-none">
      {/* Brand mark + wordmark */}
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

      {/* Live status line — only when something is flowing */}
      {hasStatus && (
        <div className="ml-[30px] mt-1 flex items-center gap-1.5 text-[10px] font-mono tabular-nums uppercase tracking-wider text-white/55">
          <span
            aria-hidden="true"
            className="w-1.5 h-1.5 rounded-full bg-white/80 animate-pulse"
          />
          <span>
            {satsLive && `Live · ${satelliteCount.toLocaleString()} sats`}
            {satsLive && kpLive && ' · '}
            {kpLive && `Kp ${auroraKp.toFixed(1)}`}
          </span>
        </div>
      )}
    </div>
  )
}
