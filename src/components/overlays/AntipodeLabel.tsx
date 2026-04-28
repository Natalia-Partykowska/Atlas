import { useEffect, useState } from 'react'
import type * as maplibregl from 'maplibre-gl'

export interface AntipodeInfo {
  origin: [number, number]
  antipodePt: [number, number]
  label: string
}

interface Props {
  info: AntipodeInfo | null
  mapRef: React.RefObject<maplibregl.Map | null>
}

export default function AntipodeLabel({ info, mapRef }: Props) {
  const [screenPos, setScreenPos] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    const map = mapRef.current
    if (!map || !info) {
      setScreenPos(null)
      return
    }

    const update = () => {
      const pt = map.project(info.antipodePt as maplibregl.LngLatLike)
      setScreenPos({ x: pt.x, y: pt.y })
    }

    update()
    map.on('move', update)
    map.on('zoom', update)
    return () => {
      map.off('move', update)
      map.off('zoom', update)
    }
  }, [info, mapRef])

  if (!info || !screenPos) return null

  const [oLng, oLat] = info.origin
  const [aLng, aLat] = info.antipodePt

  return (
    <div
      className="absolute z-50 pointer-events-none"
      style={{ left: screenPos.x, top: screenPos.y, transform: 'translate(-50%, 16px)' }}
    >
      <div className="bg-[#0B1220]/75 border border-white/[0.08] backdrop-blur-sm rounded-lg px-3 py-2 text-xs text-white/90 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_10px_25px_-8px_rgba(0,0,0,0.6)] min-w-[200px]">
        <div className="text-white/50 mb-1 text-[10px] uppercase tracking-wider">Antipode</div>
        <div className="font-medium text-orange-400 mb-1">{info.label}</div>
        <div className="text-white/40 text-[10px] leading-relaxed">
          <div>
            Origin: {oLat.toFixed(2)}°, {oLng.toFixed(2)}°
          </div>
          <div>
            Antipode: {aLat.toFixed(2)}°, {aLng.toFixed(2)}°
          </div>
        </div>
        <div className="border-t border-white/10 pt-1.5 mt-1.5 text-white/40 text-[10px]">
          Exact opposite side of Earth
        </div>
      </div>
    </div>
  )
}
