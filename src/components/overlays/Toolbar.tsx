import { useAtlasStore } from '@/stores/useAtlasStore'
import { kpColor } from '@/lib/aurora'

function ToolBtn({
  label,
  active,
  onClick,
  title,
}: {
  label: string
  active: boolean
  onClick: () => void
  title: string
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={[
        'w-full px-3 py-2 rounded-lg text-xs font-medium transition-all duration-200',
        'border backdrop-blur-sm text-left',
        active
          ? 'bg-white/10 border-white/30 text-white shadow-lg'
          : 'bg-black/30 border-white/10 text-white/50 hover:bg-white/5 hover:border-white/20 hover:text-white/80',
      ].join(' ')}
    >
      {label}
    </button>
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
  const setTerminatorVisible = useAtlasStore((s) => s.setTerminatorVisible)
  const setAuroraVisible = useAtlasStore((s) => s.setAuroraVisible)
  const auroraKp = useAtlasStore((s) => s.auroraKp)
  const auroraLabel = useAtlasStore((s) => s.auroraLabel)
  const auroraDataUnavailable = useAtlasStore((s) => s.auroraDataUnavailable)

  return (
    <div className="fixed top-4 right-4 z-40 flex flex-col items-end gap-2">
      {/* Interactive tools — mutually exclusive */}
      <div className="flex flex-col gap-1.5 w-36">
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

      {/* Divider */}
      <div className="w-36 border-t border-white/10" />

      {/* Ambient overlays — stackable */}
      <div className="flex flex-col gap-1.5 w-36">
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
              <span className="text-[10px] text-white/50">
                Kp {auroraKp.toFixed(1)} — {auroraLabel}
                {auroraDataUnavailable && ' (offline)'}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Context hint for active modes */}
      {measureMode && (
        <p className="text-white/40 text-[10px] text-right leading-tight max-w-[144px]">
          Click two points to measure distance
        </p>
      )}
      {compareMode && (
        <p className="text-white/40 text-[10px] text-right leading-tight max-w-[144px]">
          Click a country to pick it up
        </p>
      )}
      {antipodeMode && (
        <p className="text-white/40 text-[10px] text-right leading-tight max-w-[144px]">
          Click anywhere to find its antipode
        </p>
      )}
    </div>
  )
}
