import { useEffect, useMemo, useState } from 'react'
import { useAtlasStore } from '@/stores/useAtlasStore'
import type { ConjunctionEvent } from '@/lib/orbitStream'
import { MAX_VISIBLE_ROWS, conjunctionPairKey, isSamePair } from '@/lib/conjunctionEvents'
import { speakConjunction, stopSatelliteVoice } from '@/lib/satelliteVoice'
import { SpeakerIcon, VoiceFooter } from './VoiceControls'

const DRAWER_WIDTH_PX = 380
const TRANSITION_MS = 250

/** `T- 00:12:04` before the closest approach, `T+ 00:00:17` after it — a
 *  row stays up to a minute past it, or for as long as it's selected. */
function formatCountdown(deltaMs: number): string {
  const sign = deltaMs > 0 ? 'T-' : 'T+'
  const total = Math.floor(Math.abs(deltaMs) / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${sign} ${pad(h)}:${pad(m)}:${pad(s)}`
}

/** Row tooltip part: `STARLINK-3087 (#44713)`, or just `#44713` without a name. */
function pairLabel(name: string | undefined, norad: number): string {
  return name ? `${name} (#${norad})` : `#${norad}`
}

export default function ConjunctionPanel() {
  const conjunctionsVisible = useAtlasStore((s) => s.conjunctionsVisible)
  const globeMode = useAtlasStore((s) => s.globeMode)
  const events = useAtlasStore((s) => s.conjunctionEvents)
  const selected = useAtlasStore((s) => s.selectedConjunction)
  const setSelected = useAtlasStore((s) => s.setSelectedConjunction)
  const setConjunctionsVisible = useAtlasStore((s) => s.setConjunctionsVisible)
  const receivedFirstBatch = useAtlasStore((s) => s.conjunctionsReceivedFirstBatch)
  // Screening runs on the server: on the bundled satellites there's nothing to
  // load, so the drawer says why instead of "Loading…" or "No close approaches".
  const feedLimited = useAtlasStore((s) => s.satelliteFeed.status === 'limited')
  const canRetry = useAtlasStore((s) => s.satelliteFeed.canRetry)
  const catalog = useAtlasStore((s) => s.satelliteCatalog)
  const voiceEnabled = useAtlasStore((s) => s.satelliteVoiceEnabled)

  // Drawer is "open" only when conjunctions toggle AND we're on the globe
  // (the dot/line layers are globe-only, so showing the drawer in flat mode
  // would mean staring at an empty list of unrenderable events).
  const isOpen = conjunctionsVisible && globeMode

  // 1 Hz countdown — single interval at panel scope, not per-row, and only
  // running while the drawer is open.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!isOpen) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [isOpen])

  // Escape closes the drawer.
  useEffect(() => {
    if (!isOpen) return
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setConjunctionsVisible(false)
    }
    window.addEventListener('keydown', handleEsc)
    return () => window.removeEventListener('keydown', handleEsc)
  }, [isOpen, setConjunctionsVisible])

  const sorted = useMemo(
    () => [...events].sort((a, b) => a.tcaEpochMs - b.tcaEpochMs),
    [events],
  )

  // Merged batches build up to thousands of events, so only the soonest rows
  // render (the header still counts them all). The selected row stays even
  // when newer events have pushed it past the cap.
  const rows = useMemo(() => {
    const top = sorted.slice(0, MAX_VISIBLE_ROWS)
    if (selected && !top.some((e) => isSamePair(e, selected))) {
      const sel = sorted.find((e) => isSamePair(e, selected))
      if (sel) top.push(sel)
    }
    return top
  }, [sorted, selected])

  // Closing the drawer cuts the sentence off. Keyed on the drawer, not on the
  // selection: picking a satellite on the globe clears the selection too, and
  // must not silence that satellite's name.
  useEffect(() => {
    if (!isOpen) stopSatelliteVoice('conjunction')
  }, [isOpen])

  // Called from click handlers only — the voice's AudioContext has to start
  // inside the user gesture. Silent until the catalog has named both, and for
  // an approach that has passed ("in under a minute" would be wrong).
  const say = (e: ConjunctionEvent) => {
    if (e.tcaEpochMs <= Date.now()) return
    const nameA = catalog?.get(e.noradA)?.name
    const nameB = catalog?.get(e.noradB)?.name
    if (!nameA || !nameB) return
    void speakConjunction({ nameA, nameB, tcaEpochMs: e.tcaEpochMs, missKm: e.missKm })
  }

  const handleClick = (e: ConjunctionEvent) => {
    if (isSamePair(e, selected)) {
      setSelected(null)
      stopSatelliteVoice('conjunction')
    } else {
      setSelected({ noradA: e.noradA, noradB: e.noradB })
      if (voiceEnabled) say(e)
    }
  }

  return (
    // Non-modal side drawer — no backdrop, no click-shielding. The globe
    // (and Toolbar) stay fully interactive while the panel is open, so the
    // user can zoom / pan / rotate to inspect the selected pair. Close
    // affordances: the X in the header, Escape, or the Conjunctions toolbar
    // button.
    <aside
      aria-label="Predicted satellite conjunctions"
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
          <h2 className="text-white/90 text-sm font-medium flex-1">
            Conjunctions
            {/* No count while "Loading…" — it would be a guess, not a result. */}
            {receivedFirstBatch && !feedLimited && (
              <span className="text-white/40 text-xs font-normal ml-2">
                {sorted.length.toLocaleString()} {sorted.length === 1 ? 'event' : 'events'}
              </span>
            )}
          </h2>
          <button
            onClick={() => setConjunctionsVisible(false)}
            aria-label="Close conjunction panel"
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
          {feedLimited ? (
            <div className="px-4 py-4 text-xs space-y-1">
              <p className="text-white/60">
                {canRetry
                  ? 'Conjunction screening needs the live feed.'
                  : 'Conjunction screening needs the live orbit server.'}
              </p>
              {canRetry && <p className="text-white/35">Reconnecting…</p>}
            </div>
          ) : !receivedFirstBatch ? (
            <p className="text-white/50 text-xs px-4 py-4 flex items-center gap-2">
              <span
                aria-hidden
                className="inline-block w-3 h-3 rounded-full border-2 border-white/30 border-t-white/80 animate-spin"
              />
              Loading…
            </p>
          ) : sorted.length === 0 ? (
            <p className="text-white/40 text-xs px-4 py-4">
              No close approaches in next 2&nbsp;h.
            </p>
          ) : (
            <ul className="divide-y divide-white/5">
              {rows.map((e) => {
                const isSel = isSamePair(e, selected)
                const dt = e.tcaEpochMs - now
                // Names come from the /catalog fetch; until it lands (or for
                // an object it doesn't know) the NORAD number stands in.
                const nameA = catalog?.get(e.noradA)?.name
                const nameB = catalog?.get(e.noradB)?.name
                return (
                  // One row per pair — the key survives a re-estimated TCA.
                  <li key={conjunctionPairKey(e.noradA, e.noradB)} className="relative">
                    <button
                      onClick={() => handleClick(e)}
                      title={`${pairLabel(nameA, e.noradA)} ↔ ${pairLabel(nameB, e.noradB)}`}
                      className={[
                        'w-full text-left px-4 py-3 transition-colors duration-150',
                        isSel
                          ? 'bg-red-500/10 hover:bg-red-500/15'
                          : 'hover:bg-white/5',
                      ].join(' ')}
                    >
                      {/* Each name truncates on its own so a long first name
                          can't push the second one out of the row. */}
                      <div className="flex items-baseline gap-1.5 text-white/90 text-sm font-medium">
                        <span className="truncate min-w-0">{nameA ?? `#${e.noradA}`}</span>
                        <span className="shrink-0 text-white/40">↔</span>
                        <span className="truncate min-w-0">{nameB ?? `#${e.noradB}`}</span>
                      </div>
                      {(nameA || nameB) && (
                        <div className="text-white/35 text-[11px] mt-0.5 font-mono tabular-nums">
                          #{e.noradA} ↔ #{e.noradB}
                        </div>
                      )}
                      <div className="text-white/55 text-xs mt-0.5 font-mono tabular-nums">
                        miss {e.missKm.toFixed(2)} km · Δv{' '}
                        {e.relVelKms.toFixed(1)} km/s
                      </div>
                      <div
                        className={[
                          'text-xs mt-1 font-mono tabular-nums',
                          dt <= 0
                            ? 'text-white/30'
                            : dt < 5 * 60 * 1000
                              ? 'text-red-300'
                              : 'text-white/45',
                        ].join(' ')}
                      >
                        {formatCountdown(dt)}
                      </div>
                    </button>
                    {isSel && nameA && nameB && dt > 0 && (
                      // A sibling of the row button (buttons can't nest), level
                      // with the countdown. Replays even when "Read aloud" is
                      // off — it's an explicit ask. Gone once the approach has
                      // passed.
                      <button
                        onClick={() => say(e)}
                        aria-label="Read this conjunction aloud"
                        title="Read aloud"
                        className="absolute right-4 bottom-3 text-white/40 hover:text-white/80 transition-colors p-1 -m-1"
                      >
                        <SpeakerIcon />
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          {receivedFirstBatch && sorted.length > MAX_VISIBLE_ROWS && (
            <p className="text-white/35 text-[11px] px-4 py-3 border-t border-white/5">
              Showing the {MAX_VISIBLE_ROWS} soonest of {sorted.length.toLocaleString()}
            </p>
          )}
      </div>

      <VoiceFooter />
    </aside>
  )
}
