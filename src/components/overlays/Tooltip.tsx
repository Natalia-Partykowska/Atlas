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
          className="fixed z-50 pointer-events-none bg-[#0F1623CC] backdrop-blur-sm border border-[#1E2A3A] rounded-md px-3 py-2 text-sm text-[#F1F5F9] shadow-lg"
          style={{ left: tooltip.x + 14, top: tooltip.y - 10 }}
        >
          <div className="font-medium">{tooltip.name}</div>
          {formattedValue !== null && (
            <div className="text-xs text-white/60 mt-0.5">{formattedValue}</div>
          )}
        </div>
      )}
      {satelliteHover.visible && (
        <div
          className="fixed z-50 pointer-events-none bg-[#0F1623CC] backdrop-blur-sm border border-[#1E2A3A] rounded-md px-2.5 py-1.5 text-xs text-[#F1F5F9] shadow-lg"
          style={{ left: satelliteHover.x + 14, top: satelliteHover.y - 10 }}
        >
          <div className="font-medium tabular-nums">{satelliteHover.name}</div>
        </div>
      )}
    </>
  )
}
