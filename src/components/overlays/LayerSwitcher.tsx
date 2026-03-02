import { LAYERS } from '@/data/layers.config'
import { useAtlasStore } from '@/stores/useAtlasStore'

export default function LayerSwitcher() {
  const activeLayerId = useAtlasStore((s) => s.activeLayerId)
  const setActiveLayerId = useAtlasStore((s) => s.setActiveLayerId)

  return (
    <div className="fixed left-4 top-1/2 -translate-y-1/2 z-40 flex flex-col gap-1.5">
      {LAYERS.map((layer) => {
        const isActive = layer.id === activeLayerId
        return (
          <button
            key={layer.id}
            onClick={() => setActiveLayerId(layer.id)}
            title={layer.description}
            className={[
              'text-left px-3 py-2 rounded-lg text-xs font-medium transition-all duration-200',
              'border backdrop-blur-sm',
              isActive
                ? 'bg-white/10 border-white/30 text-white shadow-lg'
                : 'bg-black/30 border-white/10 text-white/50 hover:bg-white/5 hover:border-white/20 hover:text-white/80',
            ].join(' ')}
          >
            {layer.label}
          </button>
        )
      })}
    </div>
  )
}
