import { useEffect, useState } from 'react'
import { useAtlasStore } from '@/stores/useAtlasStore'

interface ModeInfo {
  name: string
  hint: string
}

function activeModeInfo(
  measureMode: boolean,
  compareMode: boolean,
  antipodeMode: boolean,
): ModeInfo | null {
  if (measureMode) return { name: 'Measure', hint: 'Click two points to measure distance' }
  if (compareMode) return { name: 'Compare', hint: 'Click a country to pick it up' }
  if (antipodeMode) return { name: 'Antipode', hint: 'Click anywhere to find its antipode' }
  return null
}

// Top-center pill that surfaces the currently-active interactive mode and
// the matching click hint. Modes are mutually exclusive in the store, so at
// most one is active at any time.
//
// Animation: the wrapper is always mounted; visibility is driven by
// translateY. When a mode flips off, we keep the previous mode's text in
// `stickyInfo` so the slide-out animates with the right label still visible
// instead of clearing mid-flight.
//
// IMPORTANT: the effect depends on the primitive flags, not on the derived
// `info` object — `activeModeInfo` returns a fresh object every render, so
// using `[info]` as the dep would re-fire `setStickyInfo` every render and
// loop forever.
export default function ModeBanner() {
  const measureMode = useAtlasStore((s) => s.measureMode)
  const compareMode = useAtlasStore((s) => s.compareMode)
  const antipodeMode = useAtlasStore((s) => s.antipodeMode)

  const info = activeModeInfo(measureMode, compareMode, antipodeMode)
  const isOpen = info !== null

  const [stickyInfo, setStickyInfo] = useState<ModeInfo | null>(null)
  useEffect(() => {
    const next = activeModeInfo(measureMode, compareMode, antipodeMode)
    if (next) setStickyInfo(next)
  }, [measureMode, compareMode, antipodeMode])

  const displayInfo = info ?? stickyInfo

  return (
    <div
      aria-hidden={!isOpen}
      role="status"
      className={[
        'fixed top-4 left-1/2 z-40 -translate-x-1/2 pointer-events-none',
        'transition-transform duration-200 ease-out',
        isOpen ? 'translate-y-0' : '-translate-y-[200%]',
      ].join(' ')}
    >
      {displayInfo && (
        <div className="px-4 py-1.5 rounded-full bg-[#0B1220]/55 border border-white/[0.12] backdrop-blur-sm shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] flex items-center gap-2.5 whitespace-nowrap">
          <span className="text-white/90 font-mono uppercase tracking-wider text-[10px] font-semibold">
            {displayInfo.name} Mode
          </span>
          <span aria-hidden="true" className="text-white/25 text-[10px]">
            ·
          </span>
          <span className="text-white/55 text-[11px]">{displayInfo.hint}</span>
          <span aria-hidden="true" className="text-white/25 text-[10px]">
            ·
          </span>
          <span className="text-white/40 font-mono uppercase tracking-wider text-[10px]">
            Esc to exit
          </span>
        </div>
      )}
    </div>
  )
}
