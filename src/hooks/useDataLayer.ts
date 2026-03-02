import { useEffect, useRef } from 'react'
import type * as maplibregl from 'maplibre-gl'
import { useAtlasStore } from '@/stores/useAtlasStore'
import { LAYER_MAP } from '@/data/layers.config'
import { buildMatchExpression } from '@/lib/mapPaint'
import type { CountryDataMap } from '@/types/atlas'

export function useDataLayer(
  mapRef: React.RefObject<maplibregl.Map | null>,
  isLoaded: boolean,
) {
  const activeLayerId = useAtlasStore((s) => s.activeLayerId)
  const setLayerData = useAtlasStore((s) => s.setLayerData)
  // Cache fetched data so switching back doesn't re-fetch
  const cacheRef = useRef<Record<string, CountryDataMap>>({})

  useEffect(() => {
    const map = mapRef.current
    if (!map || !isLoaded) return

    const layer = LAYER_MAP[activeLayerId]
    if (!layer) return

    const paint = (data: CountryDataMap) => {
      setLayerData(data)
      const expr = buildMatchExpression(data, layer.colorLow, layer.colorHigh)
      map.setPaintProperty('country-fills', 'fill-color', expr)
    }

    if (cacheRef.current[activeLayerId]) {
      paint(cacheRef.current[activeLayerId])
      return
    }

    fetch(layer.dataFile)
      .then((r) => r.json())
      .then((data: CountryDataMap) => {
        cacheRef.current[activeLayerId] = data
        paint(data)
      })
      .catch((err) => console.error(`Failed to load layer "${activeLayerId}":`, err))
  }, [activeLayerId, isLoaded, mapRef, setLayerData])
}
