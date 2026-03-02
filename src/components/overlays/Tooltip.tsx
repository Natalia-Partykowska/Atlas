import { useAtlasStore } from '@/stores/useAtlasStore'

export default function Tooltip() {
  const { tooltip } = useAtlasStore()

  if (!tooltip.visible) return null

  return (
    <div
      className="fixed z-50 pointer-events-none bg-[#0F1623CC] backdrop-blur-sm border border-[#1E2A3A] rounded-md px-3 py-2 text-sm text-[#F1F5F9] shadow-lg"
      style={{ left: tooltip.x + 14, top: tooltip.y - 10 }}
    >
      {tooltip.name}
    </div>
  )
}
