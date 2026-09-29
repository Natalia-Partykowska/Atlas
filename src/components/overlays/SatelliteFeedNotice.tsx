import { useEffect, useRef, useState } from 'react'
import { useAtlasStore } from '@/stores/useAtlasStore'
import type { SatelliteFeedState } from '@/lib/satelliteFeed'

const RESTORED_MS = 3_000

// Top-center pill shown while the globe is on the bundled satellites because
// the live orbit server can't be reached: what the user is looking at, when
// the next reconnect attempt runs, and a way to try now. The feed controller
// keeps retrying either way; × only hides the pill until this outage ends.
// When the live feed comes back, the pill says so for 3 s.
//
// The region is always mounted, so screen readers announce its changes. The
// ticking seconds are hidden from them; they hear "Retrying automatically".
export default function SatelliteFeedNotice() {
  const satellitesVisible = useAtlasStore((s) => s.satellitesVisible)
  const globeMode = useAtlasStore((s) => s.globeMode)
  const feed = useAtlasStore((s) => s.satelliteFeed)
  const satelliteCount = useAtlasStore((s) => s.satelliteCount)
  const requestSatelliteRetry = useAtlasStore((s) => s.requestSatelliteRetry)
  // ModeBanner sits at the same top-center spot; move below it when it shows.
  const modeBannerOpen = useAtlasStore((s) => s.measureMode || s.antipodeMode || s.compareMode)
  // The satellite and Conjunctions drawers cover the right 380 px; centre in
  // the map area left of them so "Retry now" never slides underneath.
  const drawerOpen = useAtlasStore(
    (s) => s.globeMode && ((s.satellitesVisible && s.selectedSatellite !== null) || s.conjunctionsVisible),
  )

  const inView = satellitesVisible && globeMode
  const limited = inView && feed.status === 'limited'

  const [dismissed, setDismissed] = useState(false)
  useEffect(() => {
    if (feed.status !== 'limited') setDismissed(false)
  }, [feed.status])

  // "Live feed restored" only after an outage that showed the pill, not after
  // a brief drop that recovered within the grace.
  const [restoredCount, setRestoredCount] = useState<number | null>(null)
  const prevStatus = useRef(feed.status)
  useEffect(() => {
    const prev = prevStatus.current
    prevStatus.current = feed.status
    if (prev === 'limited' && feed.status === 'live') {
      setRestoredCount(useAtlasStore.getState().satelliteFeed.lastLiveCount ?? 0)
      const id = window.setTimeout(() => setRestoredCount(null), RESTORED_MS)
      return () => window.clearTimeout(id)
    }
    if (feed.status !== 'live') setRestoredCount(null)
  }, [feed.status])

  // 1 Hz countdown, running only while it's on screen.
  const [now, setNow] = useState(() => Date.now())
  const ticking = limited && !dismissed && feed.nextRetryAt !== null
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [ticking, feed.nextRetryAt])

  const showOutage = limited && !dismissed
  const showRestored = !showOutage && inView && feed.status === 'live' && restoredCount !== null

  return (
    <div
      role="status"
      aria-live="polite"
      className={[
        'fixed -translate-x-1/2 z-40 pointer-events-none motion-safe:transition-[left] motion-safe:duration-200',
        drawerOpen ? 'left-[calc((100vw-380px)/2)]' : 'left-1/2',
        modeBannerOpen ? 'top-14' : 'top-4',
      ].join(' ')}
    >
      {showOutage ? (
        <Pill tone="amber" beside={drawerOpen}>
          <span className="text-amber-200/90 font-medium">Live satellite feed unavailable</span>
          <Separator />
          <span className="text-white/55">{bundledText(satelliteCount, feed.lastLiveCount)}</span>
          <Separator />
          <RetryText feed={feed} now={now} />
          {feed.canRetry && (
            <button
              type="button"
              onClick={requestSatelliteRetry}
              disabled={feed.attempting || feed.offline}
              className="text-white/85 font-medium rounded px-1 -mx-1 hover:text-white hover:underline underline-offset-2 disabled:text-white/30 disabled:no-underline focus-visible:outline focus-visible:outline-1 focus-visible:outline-white/60"
            >
              Retry now
            </button>
          )}
          <button
            type="button"
            onClick={() => setDismissed(true)}
            aria-label="Hide notice"
            className="text-white/40 hover:text-white/80 transition-colors rounded p-0.5 -m-0.5 focus-visible:outline focus-visible:outline-1 focus-visible:outline-white/60"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </Pill>
      ) : showRestored ? (
        <Pill tone="white" beside={drawerOpen}>
          <span className="text-white/80">
            {restoredCount
              ? `Live feed restored · ${restoredCount.toLocaleString()} satellites`
              : 'Live feed restored'}
          </span>
        </Pill>
      ) : null}
    </div>
  )
}

function bundledText(count: number, lastLiveCount: number | null): string {
  // The count is 0 for a moment while the bundled file loads.
  const shown = count > 0 ? `Showing ${count.toLocaleString()} bundled satellites` : 'Showing the bundled satellites'
  return lastLiveCount ? `${shown} instead of ${lastLiveCount.toLocaleString()}` : shown
}

function RetryText({ feed, now }: { feed: SatelliteFeedState; now: number }) {
  const muted = 'text-white/45'
  if (!feed.canRetry) return <span className={muted}>Live orbit server not configured</span>
  if (feed.offline) return <span className={muted}>Waiting for network</span>
  if (feed.attempting || feed.nextRetryAt === null) return <span className={muted}>Reconnecting…</span>
  const seconds = Math.max(1, Math.ceil((feed.nextRetryAt - now) / 1000))
  return (
    <>
      <span className="sr-only">Retrying automatically</span>
      <span aria-hidden="true" className={`${muted} tabular-nums`}>
        Retrying in {seconds} s
      </span>
    </>
  )
}

interface PillProps {
  tone: 'amber' | 'white'
  /** A drawer is open: the pill shares the map area left of it. */
  beside: boolean
  children: React.ReactNode
}

function Pill({ tone, beside, children }: PillProps) {
  return (
    <div
      className={[
        // 200 px on each side keeps it clear of the brand line and the toolbar
        // (or the drawer); past that it wraps onto a second line.
        beside ? 'max-w-[max(16rem,calc(100vw-780px))]' : 'max-w-[max(16rem,calc(100vw-400px))]',
        'pointer-events-auto px-4 py-1.5 rounded-2xl',
        'flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1 text-[11px]',
        'bg-[#0B1220]/55 border backdrop-blur-sm shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]',
        'motion-safe:animate-[feed-notice-in_200ms_ease-out]',
        tone === 'amber' ? 'border-amber-300/25' : 'border-white/[0.12]',
      ].join(' ')}
    >
      <span
        aria-hidden="true"
        className={['w-1.5 h-1.5 rounded-full shrink-0', tone === 'amber' ? 'bg-amber-400' : 'bg-white/80'].join(' ')}
      />
      {children}
    </div>
  )
}

function Separator() {
  return (
    <span aria-hidden="true" className="text-white/25">
      ·
    </span>
  )
}
