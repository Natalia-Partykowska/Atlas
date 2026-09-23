import { useAtlasStore } from '@/stores/useAtlasStore'
import { kpColor } from '@/lib/aurora'

function ToolBtn({
  label,
  active,
  onClick,
  title,
  accent,
}: {
  label: string
  active: boolean
  onClick: () => void
  title: string
  /** Optional hex accent colour — renders a leading glowing dot + tinted border/glow to make the button stand out. */
  accent?: string
}) {
  // Accent buttons override the neutral border/glow with their colour via inline
  // styles (Tailwind can't take a runtime hex). Non-accent buttons are untouched.
  const accentStyle: React.CSSProperties | undefined = accent
    ? active
      ? {
          borderColor: `${accent}80`,
          boxShadow: `inset 0 1px 0 rgba(255,255,255,0.10), 0 0 18px -4px ${accent}`,
        }
      : { borderColor: `${accent}40` }
    : undefined

  return (
    <button
      onClick={onClick}
      title={title}
      className={[
        'w-full px-3 py-2 rounded-lg text-xs font-medium transition-all duration-200',
        'border backdrop-blur-sm text-left',
        accent ? 'flex items-center gap-2' : '',
        active
          ? 'bg-white/[0.08] border-white/30 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.10),0_0_14px_-6px_rgba(255,255,255,0.18)]'
          : 'bg-[#0B1220]/40 border-white/[0.08] text-white/50 hover:bg-white/5 hover:border-white/20 hover:text-white/80 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]',
      ].join(' ')}
      style={accentStyle}
    >
      {accent && (
        <span
          className={['w-1.5 h-1.5 rounded-full shrink-0', active ? '' : 'animate-pulse'].join(' ')}
          style={{ background: accent, boxShadow: `0 0 6px ${accent}` }}
        />
      )}
      {label}
    </button>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-wider text-white/35 font-medium px-3">
      {children}
    </div>
  )
}

export default function Toolbar() {
  const compareMode = useAtlasStore((s) => s.compareMode)
  const measureMode = useAtlasStore((s) => s.measureMode)
  const antipodeMode = useAtlasStore((s) => s.antipodeMode)
  const globeMode = useAtlasStore((s) => s.globeMode)
  const terminatorVisible = useAtlasStore((s) => s.terminatorVisible)
  const auroraVisible = useAtlasStore((s) => s.auroraVisible)

  const setCompareMode = useAtlasStore((s) => s.setCompareMode)
  const setMeasureMode = useAtlasStore((s) => s.setMeasureMode)
  const setAntipodeMode = useAtlasStore((s) => s.setAntipodeMode)
  const submarineCablesVisible = useAtlasStore((s) => s.submarineCablesVisible)
  const setSubmarineCablesVisible = useAtlasStore((s) => s.setSubmarineCablesVisible)
  const satellitesVisible = useAtlasStore((s) => s.satellitesVisible)
  const setSatellitesVisible = useAtlasStore((s) => s.setSatellitesVisible)
  const conjunctionsVisible = useAtlasStore((s) => s.conjunctionsVisible)
  const setConjunctionsVisible = useAtlasStore((s) => s.setConjunctionsVisible)
  const setTerminatorVisible = useAtlasStore((s) => s.setTerminatorVisible)
  const setAuroraVisible = useAtlasStore((s) => s.setAuroraVisible)
  const auroraKp = useAtlasStore((s) => s.auroraKp)
  const auroraLabel = useAtlasStore((s) => s.auroraLabel)
  const auroraDataUnavailable = useAtlasStore((s) => s.auroraDataUnavailable)

  return (
    <div className="fixed top-4 right-4 z-40 flex flex-col items-end gap-2 w-36">
      {/* Tools — mutually exclusive interactive modes */}
      <div className="flex flex-col gap-1 w-full">
        <SectionLabel>Tools</SectionLabel>
        <div className="flex flex-col gap-1.5">
          <ToolBtn
            label="Measure"
            active={measureMode}
            onClick={() => setMeasureMode(!measureMode)}
            title="Measure true great-circle distance vs Mercator straight line"
          />
          {!globeMode && (
            <ToolBtn
              label="Compare Sizes"
              active={compareMode}
              onClick={() => setCompareMode(!compareMode)}
              title="Drag country outlines to compare sizes (Mercator distortion)"
            />
          )}
          <ToolBtn
            label="Antipodes"
            active={antipodeMode}
            onClick={() => setAntipodeMode(!antipodeMode)}
            title="Click anywhere to see its exact opposite point on Earth"
          />
        </div>
      </div>

      {/* Orbital — globe-exclusive */}
      {globeMode && (
        <div className="flex flex-col gap-1 w-full">
          <SectionLabel>Orbital</SectionLabel>
          <div className="flex flex-col gap-1.5">
            <ToolBtn
              label="Sea Cables"
              active={submarineCablesVisible}
              onClick={() => setSubmarineCablesVisible(!submarineCablesVisible)}
              title="Show submarine internet cables across the ocean floor"
            />
          </div>
        </div>
      )}

      {/* Overlays — stackable ambient layers */}
      <div className="flex flex-col gap-1 w-full">
        <SectionLabel>Overlays</SectionLabel>
        <div className="flex flex-col gap-1.5">
          <ToolBtn
            label="Day/Night"
            active={terminatorVisible}
            onClick={() => setTerminatorVisible(!terminatorVisible)}
            title="Show real-time solar day/night terminator"
          />
          <div className="relative">
            <ToolBtn
              label="Aurora"
              active={auroraVisible}
              onClick={() => setAuroraVisible(!auroraVisible)}
              title="Show aurora borealis/australis based on real-time NOAA Kp index"
            />
            {auroraVisible && (
              <div className="mt-1 flex items-center gap-1.5 px-1">
                <div
                  className="w-2 h-2 rounded-full"
                  style={{ background: kpColor(auroraKp) }}
                />
                <span className="text-[10px] text-white/50 font-mono tabular-nums">
                  Kp {auroraKp.toFixed(1)} — {auroraLabel}
                  {auroraDataUnavailable && ' (offline)'}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Satellites — separated orbital tracking group (globe-only) */}
      {globeMode && (
        <div className="flex flex-col gap-1 w-full mt-8">
          <SectionLabel>Satellites</SectionLabel>
          <div className="flex flex-col gap-1.5">
            <ToolBtn
              label="Satellites"
              active={satellitesVisible}
              onClick={() => setSatellitesVisible(!satellitesVisible)}
              title="Show ~250 real-time satellites (ISS, Starlink, GPS)"
              accent="#00E5FF"
            />
            {satellitesVisible && (
              <ToolBtn
                label="Conjunctions"
                active={conjunctionsVisible}
                onClick={() => setConjunctionsVisible(!conjunctionsVisible)}
                title="Show predicted close-approach events between satellites"
              />
            )}
          </div>
        </div>
      )}

    </div>
  )
}
