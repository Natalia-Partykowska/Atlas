import { useAtlasStore } from '@/stores/useAtlasStore'
import { LAYER_MAP } from '@/data/layers.config'

export default function Tooltip() {
  const tooltip = useAtlasStore((s) => s.tooltip)
  const layerData = useAtlasStore((s) => s.layerData)
  const activeLayerId = useAtlasStore((s) => s.activeLayerId)
  const satelliteHover = useAtlasStore((s) => s.satelliteHover)

  const layer = LAYER_MAP[activeLayerId]
  const value = layerData?.[tooltip.iso]
  const formattedValue = value !== undefined && layer ? layer.format(value) : null

  return (
    <>
      {tooltip.visible && (
        <div
          className="fixed z-50 pointer-events-none bg-[#0B1220]/85 backdrop-blur-sm border border-white/[0.08] rounded-md px-3 py-2 text-sm text-[#F1F5F9] shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_8px_20px_-6px_rgba(0,0,0,0.6)]"
          style={{ left: tooltip.x + 14, top: tooltip.y - 10 }}
        >
          <div className="font-medium">{tooltip.name}</div>
          {formattedValue !== null && (
            <div className="text-xs text-white/60 font-mono tabular-nums mt-0.5">{formattedValue}</div>
          )}
        </div>
      )}
      {satelliteHover.visible && (
        <div
          className="fixed z-50 pointer-events-none bg-[#0B1220]/85 backdrop-blur-sm border border-white/[0.08] rounded-md px-2.5 py-1.5 text-xs text-[#F1F5F9] shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_8px_20px_-6px_rgba(0,0,0,0.6)]"
          style={{ left: satelliteHover.x + 14, top: satelliteHover.y - 10 }}
        >
          <div className="font-medium font-mono tabular-nums">{satelliteHover.name}</div>
        </div>
      )}
    </>
  )
}
