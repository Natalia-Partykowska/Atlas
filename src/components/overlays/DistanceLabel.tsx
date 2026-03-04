import { useEffect, useState } from 'react'
import type * as maplibregl from 'maplibre-gl'

interface MeasureInfo {
  distanceKm: number
  rhumbKm: number
  midpoint: [number, number]
}

interface Props {
  info: MeasureInfo | null
  mapRef: React.RefObject<maplibregl.Map | null>
}

export default function DistanceLabel({ info, mapRef }: Props) {
  const [screenPos, setScreenPos] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    const map = mapRef.current
    if (!map || !info) {
      setScreenPos(null)
      return
    }

    const update = () => {
      const pt = map.project(info.midpoint as maplibregl.LngLatLike)
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

  const distortionPct = ((info.rhumbKm / info.distanceKm - 1) * 100).toFixed(1)
  const distortionSign = info.rhumbKm > info.distanceKm ? '+' : ''
  const distMi = (info.distanceKm * 0.621371).toFixed(0)
  const distKm = info.distanceKm.toFixed(0)
  const rhumbKm = info.rhumbKm.toFixed(0)

  return (
    <div
      className="absolute z-50 pointer-events-none"
      style={{
        left: screenPos.x,
        top: screenPos.y,
        transform: 'translate(-50%, -110%)',
      }}
    >
      <div className="bg-black/70 border border-white/15 backdrop-blur-sm rounded-lg px-3 py-2 text-xs text-white/90 shadow-xl min-w-[180px]">
        <div className="flex items-center gap-1.5 mb-1.5">
          <div className="w-3 h-0.5 bg-blue-400 rounded" />
          <span className="text-white/60">Great circle</span>
          <span className="ml-auto font-semibold text-white">
            {distKm} km
          </span>
        </div>
        <div className="flex items-center gap-1.5 mb-1.5">
          <div
            className="w-3 h-0.5 rounded"
            style={{
              background: 'repeating-linear-gradient(90deg,#94a3b8 0 4px,transparent 4px 7px)',
            }}
          />
          <span className="text-white/60">Mercator line</span>
          <span className="ml-auto text-white/70">{rhumbKm} km</span>
        </div>
        <div className="border-t border-white/10 pt-1.5 flex justify-between text-white/50">
          <span>Distortion</span>
          <span className={info.rhumbKm > info.distanceKm ? 'text-amber-400' : 'text-green-400'}>
            {distortionSign}{distortionPct}%
          </span>
        </div>
        <div className="text-white/30 text-[10px] mt-0.5">{distMi} mi</div>
      </div>
    </div>
  )
}
