import { useEffect, useRef, useState } from 'react'
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { Polygon, MultiPolygon, FeatureCollection } from 'geojson'
import { useAtlasStore } from '@/stores/useAtlasStore'
import { useDataLayer } from '@/hooks/useDataLayer'
import { NO_DATA_COLOR } from '@/lib/mapPaint'
import {
  computeCentroid,
  translateGeometry,
  makeGhostFeatureCollection,
  EMPTY_FEATURE_COLLECTION,
} from '@/lib/ghostGeometry'

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

  // Compare mode refs — ghost rendering state lives here, not in Zustand
  const compareModeRef = useRef<boolean>(false)
  const ghostStatusRef = useRef<'none' | 'dragging' | 'dropped'>('none')
  const ghostGeometryRef = useRef<Polygon | MultiPolygon | null>(null)
  const ghostCentroidRef = useRef<[number, number] | null>(null)
  const ghostNameRef = useRef<string>('')
  const countryGeoLookupRef = useRef<Record<string, Polygon | MultiPolygon>>({})

  const setTooltip = useAtlasStore((s) => s.setTooltip)
  const setSelectedCountry = useAtlasStore((s) => s.setSelectedCountry)
  const compareMode = useAtlasStore((s) => s.compareMode)
  const setCompareMode = useAtlasStore((s) => s.setCompareMode)

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

      // Ghost country source — initially empty
      map.addSource('ghost-country', {
        type: 'geojson',
        data: EMPTY_FEATURE_COLLECTION,
      })

      // Ghost fill: semi-transparent white
      map.addLayer({
        id: 'ghost-fill',
        type: 'fill',
        source: 'ghost-country',
        paint: {
          'fill-color': '#FFFFFF',
          'fill-opacity': 0.45,
        },
      })

      // Ghost border: white, dashed
      map.addLayer({
        id: 'ghost-border',
        type: 'line',
        source: 'ghost-country',
        paint: {
          'line-color': '#FFFFFF',
          'line-width': 2,
          'line-dasharray': [3, 2],
        },
      })

      // Signal that the map is ready for data painting
      setIsMapLoaded(true)

      // Build geometry lookup from GeoJSON (browser-cached, same file as map source)
      fetch('/ne_110m_countries.geojson')
        .then((r) => r.json())
        .then((geojson: FeatureCollection) => {
          const lookup: Record<string, Polygon | MultiPolygon> = {}
          for (const feature of geojson.features) {
            const iso =
              (feature.properties?.ISO_A3_EH as string) ||
              (feature.properties?.ISO_A3 as string)
            if (iso && iso !== '-99' && feature.geometry) {
              lookup[iso] = feature.geometry as Polygon | MultiPolygon
            }
          }
          countryGeoLookupRef.current = lookup
        })
        .catch((err) => console.error('Ghost geometry fetch failed:', err))

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
        if (!isPaused && !compareModeRef.current) {
          if (lastTimestamp !== null) {
            const elapsed = (timestamp - lastTimestamp) / 1000
            const center = map.getCenter()
            map.setCenter([center.lng + AUTO_SCROLL_SPEED * elapsed, center.lat])
          }
          lastTimestamp = timestamp
        } else if (compareModeRef.current) {
          lastTimestamp = null // reset so no jump when mode exits
        }
        animFrameId = requestAnimationFrame(animate)
      }

      animFrameId = requestAnimationFrame(animate)

      map.on('mousedown', () => {
        isPaused = true
        lastTimestamp = null
        if (resumeTimer) clearTimeout(resumeTimer)
      })
      map.on('mouseup', () => {
        if (!compareModeRef.current) resumeAfter(5000)
      })
      map.on('touchstart', () => {
        isPaused = true
        lastTimestamp = null
        if (resumeTimer) clearTimeout(resumeTimer)
      })
      map.on('touchend', () => {
        if (!compareModeRef.current) resumeAfter(5000)
      })

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

        // Only show pointer cursor outside compare mode
        if (!compareModeRef.current) {
          map.getCanvas().style.cursor = 'pointer'
        }

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
        if (!compareModeRef.current) {
          map.getCanvas().style.cursor = ''
        }
        setTooltip({ visible: false, x: 0, y: 0, name: '', iso: '' })
      })

      // --- Ghost translate on mousemove (compare mode) ---
      map.on('mousemove', (e: maplibregl.MapMouseEvent) => {
        if (!compareModeRef.current || ghostStatusRef.current !== 'dragging') return
        if (!ghostGeometryRef.current || !ghostCentroidRef.current) return

        const dLng = e.lngLat.lng - ghostCentroidRef.current[0]
        const dLat = e.lngLat.lat - ghostCentroidRef.current[1]

        const translated = translateGeometry(ghostGeometryRef.current, dLng, dLat)
        const ghostSource = map.getSource('ghost-country') as maplibregl.GeoJSONSource
        ghostSource.setData(makeGhostFeatureCollection(translated, ghostNameRef.current))
      })

      // --- Click interaction ---
      map.on('click', 'country-fills', (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
        if (!e.features || e.features.length === 0) return
        const iso = e.features[0].properties?.ISO_A3_EH || e.features[0].properties?.ISO_A3 || null

        if (!compareModeRef.current) {
          setSelectedCountry(iso)
          return
        }

        // Compare mode: drop ghost if currently dragging
        if (ghostStatusRef.current === 'dragging') {
          ghostStatusRef.current = 'dropped'
          map.getCanvas().style.cursor = 'crosshair'
          return
        }

        // Pick up the clicked country
        if (!iso) return
        const geometry = countryGeoLookupRef.current[iso]
        if (!geometry) return

        const name = (e.features[0].properties?.NAME as string) || iso
        const centroid = computeCentroid(geometry)

        ghostGeometryRef.current = geometry
        ghostCentroidRef.current = centroid
        ghostNameRef.current = name
        ghostStatusRef.current = 'dragging'
        map.getCanvas().style.cursor = 'grabbing'

        // Paint ghost at original position immediately
        const ghostSource = map.getSource('ghost-country') as maplibregl.GeoJSONSource
        ghostSource.setData(makeGhostFeatureCollection(geometry, name))
      })

      map.on('click', (e: maplibregl.MapMouseEvent) => {
        const features = map.queryRenderedFeatures(e.point, { layers: ['country-fills'] })

        if (!compareModeRef.current) {
          if (features.length === 0) setSelectedCountry(null)
          return
        }

        // Ocean click in compare mode: drop the ghost
        if (features.length === 0 && ghostStatusRef.current === 'dragging') {
          ghostStatusRef.current = 'dropped'
          map.getCanvas().style.cursor = 'crosshair'
        }
      })

      // Escape exits compare mode
      const handleKeyDown = (ev: KeyboardEvent) => {
        if (ev.key === 'Escape' && compareModeRef.current) {
          setCompareMode(false)
        }
      }
      window.addEventListener('keydown', handleKeyDown)

      const cleanup = () => {
        cancelAnimationFrame(animFrameId)
        if (resumeTimer) clearTimeout(resumeTimer)
        window.removeEventListener('keydown', handleKeyDown)
      }
      map.once('remove', cleanup)
    })

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right')

    return () => {
      map.remove()
      mapRef.current = null
      setIsMapLoaded(false)
    }
  }, [setTooltip, setSelectedCountry, setCompareMode])

  // Sync compareMode from Zustand into refs and map state
  useEffect(() => {
    const map = mapRef.current
    if (!map || !isMapLoaded) return

    compareModeRef.current = compareMode

    if (compareMode) {
      map.dragPan.disable()
      map.getCanvas().style.cursor = 'crosshair'
    } else {
      map.dragPan.enable()
      map.getCanvas().style.cursor = ''

      // Clear ghost
      ghostStatusRef.current = 'none'
      ghostGeometryRef.current = null
      ghostCentroidRef.current = null
      ghostNameRef.current = ''
      const ghostSource = map.getSource('ghost-country') as maplibregl.GeoJSONSource | undefined
      ghostSource?.setData(EMPTY_FEATURE_COLLECTION)
    }
  }, [compareMode, isMapLoaded])

  return <div ref={containerRef} className="w-full h-full" />
}
