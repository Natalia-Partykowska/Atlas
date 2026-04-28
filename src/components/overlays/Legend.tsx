import { useAtlasStore } from '@/stores/useAtlasStore'
import { LAYER_MAP } from '@/data/layers.config'

export default function Legend() {
  const activeLayerId = useAtlasStore((s) => s.activeLayerId)
  const layerData = useAtlasStore((s) => s.layerData)
  const tooltip = useAtlasStore((s) => s.tooltip)

  const layer = LAYER_MAP[activeLayerId]
  if (!layer || !layerData) return null

  const values = Object.values(layerData).filter((v) => isFinite(v) && v >= 0)
  if (values.length === 0) return null

  const min = Math.min(...values)
  const max = Math.max(...values)

  // Hover-coupling: when the user hovers a country with a value on the
  // active data layer, drop a vertical tick on the gradient at its
  // proportional position. Pure derived state — no effect, no extra
  // re-renders. Clamped to [0,1] in case of an out-of-range value, and
  // gated on max > min to avoid divide-by-zero on single-value datasets.
  const hoverValue =
    tooltip.visible && tooltip.iso ? layerData[tooltip.iso] : undefined
  const hoverPosition =
    hoverValue !== undefined && isFinite(hoverValue) && max > min
      ? Math.max(0, Math.min(1, (hoverValue - min) / (max - min)))
      : null
  const hoverFormatted =
    hoverValue !== undefined && isFinite(hoverValue) ? layer.format(hoverValue) : null

  return (
    <div className="fixed bottom-8 left-4 z-40 w-48 px-3 py-2.5 rounded-lg bg-[#0B1220]/40 border border-white/[0.08] backdrop-blur-sm shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
      <p className="text-white/80 text-xs font-semibold mb-6">{layer.label}</p>

      {/* Gradient bar with optional hover tick */}
      <div className="relative h-2 w-full">
        <div
          className="absolute inset-0 rounded-full"
          style={{
            background: `linear-gradient(to right, ${layer.colorLow}, ${layer.colorHigh})`,
          }}
        />
        {hoverPosition !== null && (
          <>
            <div
              data-testid="legend-hover-tick"
              aria-hidden="true"
              className="absolute -top-1 -bottom-1 w-px bg-white shadow-[0_0_4px_rgba(255,255,255,0.7)] transition-[left] duration-150 ease-out pointer-events-none"
              style={{
                left: `${hoverPosition * 100}%`,
                transform: 'translateX(-50%)',
              }}
            />
            {hoverFormatted !== null && (
              <div
                data-testid="legend-hover-value"
                aria-hidden="true"
                className="absolute -top-5 px-1.5 rounded bg-[#0B1220]/80 border border-white/[0.08] text-[10px] font-mono tabular-nums text-white/85 whitespace-nowrap transition-[left] duration-150 ease-out pointer-events-none"
                style={{
                  left: `${hoverPosition * 100}%`,
                  transform: 'translateX(-50%)',
                }}
              >
                {hoverFormatted}
              </div>
            )}
          </>
        )}
      </div>

      {/* Min / Max labels */}
      <div className="flex justify-between mt-1">
        <span className="text-white/50 text-[10px] font-mono tabular-nums">{layer.format(min)}</span>
        <span className="text-white/50 text-[10px] font-mono tabular-nums">{layer.format(max)}</span>
      </div>

      <p className="text-white/30 text-[10px] mt-1 leading-tight">{layer.description}</p>
    </div>
  )
}
