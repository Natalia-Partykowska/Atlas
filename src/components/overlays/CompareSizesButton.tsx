import { useAtlasStore } from '@/stores/useAtlasStore'

export default function CompareSizesButton() {
  const compareMode = useAtlasStore((s) => s.compareMode)
  const setCompareMode = useAtlasStore((s) => s.setCompareMode)

  return (
    <div className="fixed top-4 right-4 z-40 flex flex-col items-end gap-1.5">
      <button
        onClick={() => setCompareMode(!compareMode)}
        title="Compare country sizes — drag countries to see Mercator distortion"
        className={[
          'px-3 py-2 rounded-lg text-xs font-medium transition-all duration-200',
          'border backdrop-blur-sm',
          compareMode
            ? 'bg-white/10 border-white/30 text-white shadow-lg'
            : 'bg-black/30 border-white/10 text-white/50 hover:bg-white/5 hover:border-white/20 hover:text-white/80',
        ].join(' ')}
      >
        Compare Sizes
      </button>
      {compareMode && (
        <p className="text-white/40 text-[10px] text-right leading-tight max-w-[140px]">
          Click a country to pick it up
        </p>
      )}
    </div>
  )
}
