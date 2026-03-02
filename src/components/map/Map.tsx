import { useEffect, useRef, useState } from 'react'
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useAtlasStore } from '@/stores/useAtlasStore'
import { useDataLayer } from '@/hooks/useDataLayer'
import { NO_DATA_COLOR } from '@/lib/mapPaint'

const COLORS = {
  ocean: '#0D1929',
  border: '#2A3A4E',
}

// Degrees per second — Earth-like westward drift
const AUTO_SCROLL_SPEED = 4

export default function Map() {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const hoveredIdRef = useRef<string | null>(null)
  const [isMapLoaded, setIsMapLoaded] = useState(false)

  const setTooltip = useAtlasStore((s) => s.setTooltip)
  const setSelectedCountry = useAtlasStore((s) => s.setSelectedCountry)

  // Wire data layer painting — reacts to activeLayerId changes
  useDataLayer(mapRef, isMapLoaded)

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: {
        version: 8,
        name: 'atlas-dark',
        sources: {},
        layers: [
          {
            id: 'background',
            type: 'background',
            paint: { 'background-color': COLORS.ocean },
          },
        ],
        glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
      },
      center: [20, 20],
      zoom: 2,
      minZoom: 1.5,
      maxZoom: 8,
      pitch: 0,
      maxPitch: 0,
      attributionControl: false,
    })

    mapRef.current = map

    map.dragRotate.disable()
    map.touchPitch.disable()
    map.touchZoomRotate.disableRotation()

    map.on('load', () => {
      // Country boundaries source
      map.addSource('countries', {
        type: 'geojson',
        data: '/ne_110m_countries.geojson',
        generateId: true,
      })

      // Country fill layer — driven by data (setPaintProperty updates this)
      map.addLayer({
        id: 'country-fills',
        type: 'fill',
        source: 'countries',
        paint: {
          'fill-color': NO_DATA_COLOR,
          'fill-color-transition': { duration: 400, delay: 0 },
          'fill-opacity': 1,
        },
      })

      // Country borders
      map.addLayer({
        id: 'country-borders',
        type: 'line',
        source: 'countries',
        paint: {
          'line-color': COLORS.border,
          'line-width': 0.8,
        },
      })

      // Hover highlight — semi-transparent white overlay
      map.addLayer({
        id: 'country-hover',
        type: 'fill',
        source: 'countries',
        paint: {
          'fill-color': '#FFFFFF',
          'fill-opacity': [
            'case',
            ['boolean', ['feature-state', 'hover'], false],
            0.15,
            0,
          ],
        },
      })

      // Signal that the map is ready for data painting
      setIsMapLoaded(true)

      // --- Auto-scroll animation ---
      let isPaused = false
      let lastTimestamp: number | null = null
      let animFrameId: number
      let resumeTimer: ReturnType<typeof setTimeout> | null = null

      const resumeAfter = (ms: number) => {
        if (resumeTimer) clearTimeout(resumeTimer)
        resumeTimer = setTimeout(() => {
          isPaused = false
          lastTimestamp = null
        }, ms)
      }

      const animate = (timestamp: number) => {
        if (!isPaused) {
          if (lastTimestamp !== null) {
            const elapsed = (timestamp - lastTimestamp) / 1000
            const center = map.getCenter()
            map.setCenter([center.lng + AUTO_SCROLL_SPEED * elapsed, center.lat])
          }
          lastTimestamp = timestamp
        }
        animFrameId = requestAnimationFrame(animate)
      }

      animFrameId = requestAnimationFrame(animate)

      map.on('mousedown', () => {
        isPaused = true
        lastTimestamp = null
        if (resumeTimer) clearTimeout(resumeTimer)
      })
      map.on('mouseup', () => resumeAfter(5000))
      map.on('touchstart', () => {
        isPaused = true
        lastTimestamp = null
        if (resumeTimer) clearTimeout(resumeTimer)
      })
      map.on('touchend', () => resumeAfter(5000))

      // --- Hover interaction ---
      map.on('mousemove', 'country-fills', (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        if (!e.features || e.features.length === 0) return

        const feature = e.features[0]
        const id = feature.id as number

        if (hoveredIdRef.current !== null) {
          map.setFeatureState(
            { source: 'countries', id: Number(hoveredIdRef.current) },
            { hover: false }
          )
        }

        hoveredIdRef.current = String(id)
        map.setFeatureState({ source: 'countries', id }, { hover: true })
        map.getCanvas().style.cursor = 'pointer'

        const name = feature.properties?.NAME || ''
        // ISO_A3_EH is more complete — ISO_A3 is '-99' for Norway, France, etc.
        const iso = feature.properties?.ISO_A3_EH || feature.properties?.ISO_A3 || ''
        setTooltip({ visible: true, x: e.point.x, y: e.point.y, name, iso })
      })

      map.on('mouseleave', 'country-fills', () => {
        if (hoveredIdRef.current !== null) {
          map.setFeatureState(
            { source: 'countries', id: Number(hoveredIdRef.current) },
            { hover: false }
          )
          hoveredIdRef.current = null
        }
        map.getCanvas().style.cursor = ''
        setTooltip({ visible: false, x: 0, y: 0, name: '', iso: '' })
      })

      // --- Click interaction ---
      map.on('click', 'country-fills', (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        if (!e.features || e.features.length === 0) return
        const iso = e.features[0].properties?.ISO_A3_EH || e.features[0].properties?.ISO_A3 || null
        setSelectedCountry(iso)
      })

      map.on('click', (e: maplibregl.MapMouseEvent) => {
        const features = map.queryRenderedFeatures(e.point, { layers: ['country-fills'] })
        if (features.length === 0) setSelectedCountry(null)
      })

      const cleanup = () => {
        cancelAnimationFrame(animFrameId)
        if (resumeTimer) clearTimeout(resumeTimer)
      }
      map.once('remove', cleanup)
    })

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right')

    return () => {
      map.remove()
      mapRef.current = null
      setIsMapLoaded(false)
    }
  }, [setTooltip, setSelectedCountry])

  return <div ref={containerRef} className="w-full h-full" />
}
