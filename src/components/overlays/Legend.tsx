import { useAtlasStore } from '@/stores/useAtlasStore'
import { LAYER_MAP } from '@/data/layers.config'

export default function Legend() {
  const activeLayerId = useAtlasStore((s) => s.activeLayerId)
  const layerData = useAtlasStore((s) => s.layerData)

  const layer = LAYER_MAP[activeLayerId]
  if (!layer || !layerData) return null

  const values = Object.values(layerData).filter((v) => isFinite(v) && v >= 0)
  if (values.length === 0) return null

  const min = Math.min(...values)
  const max = Math.max(...values)

  return (
    <div className="fixed bottom-8 left-4 z-40 w-48 px-3 py-2.5 rounded-lg bg-[#0B1220]/40 border border-white/[0.08] backdrop-blur-sm shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
      <p className="text-white/80 text-xs font-semibold mb-1.5">{layer.label}</p>

      {/* Gradient bar */}
      <div
        className="h-2 rounded-full w-full"
        style={{
          background: `linear-gradient(to right, ${layer.colorLow}, ${layer.colorHigh})`,
        }}
      />

      {/* Min / Max labels */}
      <div className="flex justify-between mt-1">
        <span className="text-white/50 text-[10px] font-mono tabular-nums">{layer.format(min)}</span>
        <span className="text-white/50 text-[10px] font-mono tabular-nums">{layer.format(max)}</span>
      </div>

      <p className="text-white/30 text-[10px] mt-1 leading-tight">{layer.description}</p>
    </div>
  )
}
