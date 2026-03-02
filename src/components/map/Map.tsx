import { useEffect, useRef } from 'react'
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useAtlasStore } from '@/stores/useAtlasStore'

const COLORS = {
  ocean: '#0D1929',
  land: '#1E2A3A',
  border: '#2A3A4E',
  hoverFill: '#2E4A6A',
}

export default function Map() {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const hoveredIdRef = useRef<string | null>(null)
  const setTooltip = useAtlasStore((s) => s.setTooltip)
  const setSelectedCountry = useAtlasStore((s) => s.setSelectedCountry)

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
      attributionControl: false,
    })

    mapRef.current = map

    map.on('load', () => {
      // Add country boundaries source
      map.addSource('countries', {
        type: 'geojson',
        data: '/ne_110m_countries.geojson',
        generateId: true,
      })

      // Country fill layer
      map.addLayer({
        id: 'country-fills',
        type: 'fill',
        source: 'countries',
        paint: {
          'fill-color': [
            'case',
            ['boolean', ['feature-state', 'hover'], false],
            COLORS.hoverFill,
            COLORS.land,
          ],
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

      // Hover interaction
      map.on('mousemove', 'country-fills', (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        if (!e.features || e.features.length === 0) return

        const feature = e.features[0]
        const id = feature.id as number

        // Clear previous hover
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
        const iso = feature.properties?.ISO_A3 || ''

        setTooltip({
          visible: true,
          x: e.point.x,
          y: e.point.y,
          name,
          iso,
        })
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

      // Click interaction
      map.on('click', 'country-fills', (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        if (!e.features || e.features.length === 0) return
        const iso = e.features[0].properties?.ISO_A3 || null
        setSelectedCountry(iso)
      })

      // Click on empty space deselects
      map.on('click', (e: maplibregl.MapMouseEvent) => {
        const features = map.queryRenderedFeatures(e.point, {
          layers: ['country-fills'],
        })
        if (features.length === 0) {
          setSelectedCountry(null)
        }
      })
    })

    // Add zoom controls
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right')

    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [setTooltip, setSelectedCountry])

  return <div ref={containerRef} className="w-full h-full" />
}
