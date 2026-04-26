import { useEffect, useMemo, useState } from 'react'
import { useAtlasStore } from '@/stores/useAtlasStore'
import type { ConjunctionEvent } from '@/lib/orbitStream'

const DRAWER_WIDTH_PX = 380
const TRANSITION_MS = 250

function formatCountdown(deltaMs: number): string {
  if (deltaMs <= 0) return 'T- 00:00:00'
  const total = Math.floor(deltaMs / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return `T- ${pad(h)}:${pad(m)}:${pad(s)}`
}

function isSelected(
  e: ConjunctionEvent,
  sel: { noradA: number; noradB: number } | null,
): boolean {
  if (!sel) return false
  return (
    (e.noradA === sel.noradA && e.noradB === sel.noradB) ||
    (e.noradA === sel.noradB && e.noradB === sel.noradA)
  )
}

export default function ConjunctionPanel() {
  const conjunctionsVisible = useAtlasStore((s) => s.conjunctionsVisible)
  const globeMode = useAtlasStore((s) => s.globeMode)
  const events = useAtlasStore((s) => s.conjunctionEvents)
  const selected = useAtlasStore((s) => s.selectedConjunction)
  const setSelected = useAtlasStore((s) => s.setSelectedConjunction)
  const setConjunctionsVisible = useAtlasStore((s) => s.setConjunctionsVisible)

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

  const handleClick = (e: ConjunctionEvent) => {
    if (isSelected(e, selected)) {
      setSelected(null)
    } else {
      setSelected({ noradA: e.noradA, noradB: e.noradB })
    }
  }

  return (
    <>
      {/* Backdrop — clicking it closes the drawer. Pointer events disabled
          when closed so the rest of the UI (Toolbar, globe) is interactive. */}
      <div
        onClick={() => setConjunctionsVisible(false)}
        aria-hidden
        className={[
          'fixed inset-0 z-40 bg-black/15 transition-opacity ease-out',
          isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none',
        ].join(' ')}
        style={{ transitionDuration: `${TRANSITION_MS}ms` }}
      />

      {/* Drawer — always mounted so the slide animation fires both ways. */}
      <aside
        aria-label="Predicted satellite conjunctions"
        className={[
          'fixed top-0 right-0 h-full z-50 flex flex-col',
          'bg-black/60 backdrop-blur-md border-l border-white/10',
          'transition-transform ease-out shadow-2xl',
          isOpen ? 'translate-x-0' : 'translate-x-full',
        ].join(' ')}
        style={{ width: `${DRAWER_WIDTH_PX}px`, transitionDuration: `${TRANSITION_MS}ms` }}
      >
        <header className="px-4 py-3 border-b border-white/10 flex items-center gap-2">
          <h2 className="text-white/90 text-sm font-medium flex-1">
            Conjunctions
            <span className="text-white/40 text-xs font-normal ml-2">
              {sorted.length} {sorted.length === 1 ? 'event' : 'events'}
            </span>
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
          {sorted.length === 0 ? (
            <p className="text-white/40 text-xs px-4 py-4">
              No close approaches in next 2&nbsp;h.
            </p>
          ) : (
            <ul className="divide-y divide-white/5">
              {sorted.map((e) => {
                const isSel = isSelected(e, selected)
                const dt = e.tcaEpochMs - now
                return (
                  <li key={`${e.noradA}-${e.noradB}-${e.tcaEpochMs}`}>
                    <button
                      onClick={() => handleClick(e)}
                      className={[
                        'w-full text-left px-4 py-3 transition-colors duration-150',
                        isSel
                          ? 'bg-red-500/10 hover:bg-red-500/15'
                          : 'hover:bg-white/5',
                      ].join(' ')}
                    >
                      <div className="text-white/90 text-sm font-medium tabular-nums">
                        #{e.noradA} ↔ #{e.noradB}
                      </div>
                      <div className="text-white/55 text-xs mt-0.5 tabular-nums">
                        miss {e.missKm.toFixed(2)} km · Δv{' '}
                        {e.relVelKms.toFixed(1)} km/s
                      </div>
                      <div
                        className={[
                          'text-xs mt-1 tabular-nums',
                          dt < 5 * 60 * 1000 ? 'text-red-300' : 'text-white/45',
                        ].join(' ')}
                      >
                        {formatCountdown(dt)}
                      </div>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </aside>
    </>
  )
}
