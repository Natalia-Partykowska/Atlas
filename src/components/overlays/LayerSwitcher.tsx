import { LAYERS } from '@/data/layers.config'
import { useAtlasStore } from '@/stores/useAtlasStore'

export default function LayerSwitcher() {
  const activeLayerId = useAtlasStore((s) => s.activeLayerId)
  const setActiveLayerId = useAtlasStore((s) => s.setActiveLayerId)
  const setCompareMode = useAtlasStore((s) => s.setCompareMode)
  const setMeasureMode = useAtlasStore((s) => s.setMeasureMode)
  const setAntipodeMode = useAtlasStore((s) => s.setAntipodeMode)
  const setTerminatorVisible = useAtlasStore((s) => s.setTerminatorVisible)
  const setAuroraVisible = useAtlasStore((s) => s.setAuroraVisible)

  return (
    <div className="fixed left-4 top-1/2 -translate-y-1/2 z-40 flex flex-col gap-1.5">
      {LAYERS.map((layer) => {
        const isActive = layer.id === activeLayerId
        return (
          <button
            key={layer.id}
            onClick={() => {
              setCompareMode(false)
              setMeasureMode(false)
              setAntipodeMode(false)
              if (layer.id !== 'base') {
                setTerminatorVisible(false)
                setAuroraVisible(false)
              }
              setActiveLayerId(layer.id)
            }}
            title={layer.description}
            className={[
              'relative text-left px-3 py-2 rounded-lg text-xs font-medium transition-all duration-200',
              'border backdrop-blur-sm',
              isActive
                ? 'bg-white/[0.08] border-white/30 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.10),0_0_14px_-6px_rgba(255,255,255,0.18)] before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[2px] before:rounded-full before:bg-white/70 before:shadow-[0_0_4px_rgba(255,255,255,0.3)]'
                : 'bg-[#0B1220]/40 border-white/[0.08] text-white/50 hover:bg-white/5 hover:border-white/20 hover:text-white/80 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]',
            ].join(' ')}
          >
            {layer.label}
          </button>
        )
      })}
    </div>
  )
}
