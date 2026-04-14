import { useEffect, useRef, useState } from 'react'
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { Polygon, MultiPolygon, FeatureCollection } from 'geojson'
import { useAtlasStore } from '@/stores/useAtlasStore'
import { useDataLayer } from '@/hooks/useDataLayer'
import { useAurora } from '@/hooks/useAurora'
import { NO_DATA_COLOR } from '@/lib/mapPaint'
import {
  toMercator,
  fromMercator,
  computeMercatorCentroid,
  repositionGeometry,
  makeGhostFeatureCollection,
  clipGeometryToMercatorBounds,
  EMPTY_FEATURE_COLLECTION,
} from '@/lib/ghostGeometry'
import {
  interpolateGreatCircle,
  haversineDistance,
  rhumbDistance,
  unwrapPath,
} from '@/lib/greatCircle'
import { generateAuroraWavyBands } from '@/lib/aurora'
import { computeAntipode, identifyOcean, pointInCountry } from '@/lib/antipode'
import { computeTerminator, computeTerminatorCurve } from '@/lib/solarTerminator'
import {
  parseTLEData,
  propagateAll,
  buildSatelliteGeoJSON,
  buildISSTrail,
  SATELLITE_GROUPS,
} from '@/lib/satellites'
import type { ParsedSatellite, SatTLEEntry, SatPosition } from '@/lib/satellites'
import { connectOrbitStream } from '@/lib/orbitStream'
import type { OrbitStreamHandle, ViewportBounds } from '@/lib/orbitStream'
import DistanceLabel from '@/components/overlays/DistanceLabel'
import AntipodeLabel from '@/components/overlays/AntipodeLabel'
import type { AntipodeInfo } from '@/components/overlays/AntipodeLabel'

const COLORS = {
  ocean: '#0D1929',
  border: '#2A3A4E',
}

const AUTO_SCROLL_SPEED = 4

const computeMinZoom = (width: number) => Math.log2(width / 512) + 0.05

interface MeasureInfo {
  distanceKm: number
  rhumbKm: number
  midpoint: [number, number]
}

export default function Map() {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const hoveredIdRef = useRef<string | null>(null)
  const [isMapLoaded, setIsMapLoaded] = useState(false)

  // Compare mode refs
  const compareModeRef = useRef<boolean>(false)
  const ghostStatusRef = useRef<'none' | 'dragging' | 'dropped'>('none')
  const ghostGeometryRef = useRef<Polygon | MultiPolygon | null>(null)
  const ghostCentroidRef = useRef<[number, number] | null>(null)
  const ghostNameRef = useRef<string>('')
  const countryGeoLookupRef = useRef<Record<string, Polygon | MultiPolygon>>({})
  const countryNameLookupRef = useRef<Record<string, string>>({})
  const pauseAndResumeAfterRef = useRef<((ms: number) => void) | null>(null)
  const wasInCompareModeRef = useRef(false)

  // Measure mode refs
  const measureModeRef = useRef<boolean>(false)
  const measurePointsRef = useRef<[number, number][]>([])
  const wasInMeasureModeRef = useRef(false)
  const [measureInfo, setMeasureInfo] = useState<MeasureInfo | null>(null)

  // Antipode mode refs
  const antipodeModeRef = useRef<boolean>(false)
  const wasInAntipodeModeRef = useRef(false)
  const [antipodeInfo, setAntipodeInfo] = useState<AntipodeInfo | null>(null)

  // Globe mode refs
  const globeModeRef = useRef<boolean>(false)

  // Submarine cables cache
  const cablesGeoJSONRef = useRef<object | null>(null)

  // Satellite refs
  const satelliteTLERef = useRef<ParsedSatellite[] | null>(null)
  const satelliteIntervalRef = useRef<number | null>(null)

  const setTooltip = useAtlasStore((s) => s.setTooltip)
  const setSelectedCountry = useAtlasStore((s) => s.setSelectedCountry)
  const compareMode = useAtlasStore((s) => s.compareMode)
  const setCompareMode = useAtlasStore((s) => s.setCompareMode)
  const measureMode = useAtlasStore((s) => s.measureMode)
  const setMeasureMode = useAtlasStore((s) => s.setMeasureMode)
  const antipodeMode = useAtlasStore((s) => s.antipodeMode)
  const setAntipodeMode = useAtlasStore((s) => s.setAntipodeMode)
  const globeMode = useAtlasStore((s) => s.globeMode)
  const setGlobeMode = useAtlasStore((s) => s.setGlobeMode)
  const submarineCablesVisible = useAtlasStore((s) => s.submarineCablesVisible)
  const satellitesVisible = useAtlasStore((s) => s.satellitesVisible)
  const terminatorVisible = useAtlasStore((s) => s.terminatorVisible)
  const setTerminatorVisible = useAtlasStore((s) => s.setTerminatorVisible)
  const auroraVisible = useAtlasStore((s) => s.auroraVisible)
  const setAuroraVisible = useAtlasStore((s) => s.setAuroraVisible)
  const setAuroraInfo = useAtlasStore((s) => s.setAuroraInfo)

  const aurora = useAurora(auroraVisible)

  // Sync aurora display info to store so Toolbar can read it
  useEffect(() => {
    setAuroraInfo(aurora.kp, aurora.label, aurora.dataUnavailable)
  }, [aurora.kp, aurora.label, aurora.dataUnavailable, setAuroraInfo])

  useDataLayer(mapRef, isMapLoaded)

  // ─── Map initialization ──────────────────────────────────────────────────
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
      minZoom: computeMinZoom(containerRef.current.offsetWidth),
      maxZoom: 8,
      pitch: 0,
      maxPitch: 0,
      attributionControl: false,
    })

    mapRef.current = map

    map.dragRotate.disable()
    map.touchPitch.disable()
    map.touchZoomRotate.disableRotation()

    // Intercept trackpad two-finger scroll (no ctrlKey) and pan instead of zoom.
    // Pinch-to-zoom on Mac sets ctrlKey=true — let those through to MapLibre.
    const handleWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) {
        e.preventDefault()
        e.stopImmediatePropagation()
        map.panBy([e.deltaX, e.deltaY], { duration: 0 })
      }
    }
    const mapContainer = map.getContainer()
    mapContainer.addEventListener('wheel', handleWheel, { passive: false, capture: true })

    map.on('load', () => {
      // ── Register all sources first ────────────────────────────────────────
      map.addSource('countries', {
        type: 'geojson',
        data: '/ne_110m_countries.geojson',
        generateId: true,
      })
      map.addSource('aurora-bands', {
        type: 'geojson',
        data: EMPTY_FEATURE_COLLECTION,
      })
      map.addSource('terminator-shadow', {
        type: 'geojson',
        data: EMPTY_FEATURE_COLLECTION,
      })
      map.addSource('terminator-curve', {
        type: 'geojson',
        data: EMPTY_FEATURE_COLLECTION,
      })
      map.addSource('measure-great-circle', {
        type: 'geojson',
        data: EMPTY_FEATURE_COLLECTION,
      })
      map.addSource('measure-straight-line', {
        type: 'geojson',
        data: EMPTY_FEATURE_COLLECTION,
      })
      map.addSource('measure-points', {
        type: 'geojson',
        data: EMPTY_FEATURE_COLLECTION,
      })
      map.addSource('antipode-points', {
        type: 'geojson',
        data: EMPTY_FEATURE_COLLECTION,
      })
      map.addSource('antipode-line', {
        type: 'geojson',
        data: EMPTY_FEATURE_COLLECTION,
      })
      map.addSource('aurora-ovation', {
        type: 'geojson',
        data: EMPTY_FEATURE_COLLECTION,
      })
      map.addSource('ghost-country', {
        type: 'geojson',
        data: EMPTY_FEATURE_COLLECTION,
      })
      map.addSource('submarine-cables', {
        type: 'geojson',
        data: EMPTY_FEATURE_COLLECTION,
      })
      map.addSource('satellites', {
        type: 'geojson',
        data: EMPTY_FEATURE_COLLECTION,
      })
      map.addSource('satellite-trail', {
        type: 'geojson',
        data: EMPTY_FEATURE_COLLECTION,
      })

      // ── Add layers in render order (bottom → top) ─────────────────────────

      // 1. Country data fills
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

      // 2. Aurora bands (above country fills, below borders)
      map.addLayer({
        id: 'aurora-fill',
        type: 'fill',
        source: 'aurora-bands',
        paint: {
          'fill-color': ['get', 'color'],
          'fill-opacity': ['get', 'opacity'],
        },
      })

      // 3. Aurora heatmap (real NOAA Ovation data)
      map.addLayer({
        id: 'aurora-heatmap',
        type: 'heatmap',
        source: 'aurora-ovation',
        paint: {
          'heatmap-weight': ['interpolate', ['linear'], ['get', 'probability'], 0, 0, 100, 1],
          'heatmap-intensity': 1.5,
          'heatmap-color': [
            'interpolate',
            ['linear'],
            ['heatmap-density'],
            0, 'rgba(0,0,0,0)',
            0.1, 'rgba(74,222,128,0.15)',
            0.35, 'rgba(74,222,128,0.55)',
            0.6, 'rgba(134,239,172,0.80)',
            0.8, 'rgba(52,211,153,0.90)',
            0.92, 'rgba(192,132,252,0.95)',
            1, 'rgba(232,121,249,1)',
          ],
          'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 1, 18, 6, 50],
          'heatmap-opacity': 0.85,
        },
      })

      // 4. Day/Night terminator shadow
      map.addLayer({
        id: 'terminator-fill',
        type: 'fill',
        source: 'terminator-shadow',
        paint: {
          'fill-color': 'rgba(0, 10, 30, 0.42)',
          'fill-opacity': 1,
        },
      })

      // 4. Country borders (above aurora + terminator)
      map.addLayer({
        id: 'country-borders',
        type: 'line',
        source: 'countries',
        paint: {
          'line-color': COLORS.border,
          'line-width': 0.8,
        },
      })

      // 5a. Submarine cables — glow (wide, blurred)
      map.addLayer({
        id: 'submarine-cables-glow',
        type: 'line',
        source: 'submarine-cables',
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 4,
          'line-blur': 5,
          'line-opacity': 0.3,
        },
      })

      // 5b. Submarine cables — crisp core line
      map.addLayer({
        id: 'submarine-cables-line',
        type: 'line',
        source: 'submarine-cables',
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 1.2,
          'line-opacity': 0.85,
        },
      })

      // 5d. Satellite trail — ISS predicted ground track
      map.addLayer({
        id: 'satellite-trail',
        type: 'line',
        source: 'satellite-trail',
        paint: {
          'line-color': SATELLITE_GROUPS.iss.color,
          'line-width': 1,
          'line-dasharray': [4, 4],
          'line-opacity': 0.3,
        },
      })

      // 5e. Satellites — outer glow
      map.addLayer({
        id: 'satellites-glow',
        type: 'circle',
        source: 'satellites',
        paint: {
          'circle-radius': [
            'match', ['get', 'group'],
            'iss', SATELLITE_GROUPS.iss.glowRadius,
            'gps', SATELLITE_GROUPS.gps.glowRadius,
            'station', SATELLITE_GROUPS.station.glowRadius,
            'geo', SATELLITE_GROUPS.geo.glowRadius,
            'debris', SATELLITE_GROUPS.debris.glowRadius,
            'active', SATELLITE_GROUPS.active.glowRadius,
            SATELLITE_GROUPS.starlink.glowRadius,
          ],
          'circle-color': [
            'match', ['get', 'group'],
            'iss', SATELLITE_GROUPS.iss.color,
            'gps', SATELLITE_GROUPS.gps.color,
            'station', SATELLITE_GROUPS.station.color,
            'geo', SATELLITE_GROUPS.geo.color,
            'debris', SATELLITE_GROUPS.debris.color,
            'active', SATELLITE_GROUPS.active.color,
            SATELLITE_GROUPS.starlink.color,
          ],
          'circle-blur': 1,
          'circle-opacity': [
            'match', ['get', 'group'],
            'iss', 0.4,
            'gps', 0.25,
            'station', 0.25,
            'geo', 0.25,
            'debris', 0.15,
            'active', 0.2,
            0.2,
          ],
        },
      })

      // 5f. Satellites — inner crisp dot
      map.addLayer({
        id: 'satellites-dot',
        type: 'circle',
        source: 'satellites',
        paint: {
          'circle-radius': [
            'match', ['get', 'group'],
            'iss', SATELLITE_GROUPS.iss.dotRadius,
            'gps', SATELLITE_GROUPS.gps.dotRadius,
            'station', SATELLITE_GROUPS.station.dotRadius,
            'geo', SATELLITE_GROUPS.geo.dotRadius,
            'debris', SATELLITE_GROUPS.debris.dotRadius,
            'active', SATELLITE_GROUPS.active.dotRadius,
            SATELLITE_GROUPS.starlink.dotRadius,
          ],
          'circle-color': [
            'match', ['get', 'group'],
            'iss', SATELLITE_GROUPS.iss.color,
            'gps', SATELLITE_GROUPS.gps.color,
            'station', SATELLITE_GROUPS.station.color,
            'geo', SATELLITE_GROUPS.geo.color,
            'debris', SATELLITE_GROUPS.debris.color,
            'active', SATELLITE_GROUPS.active.color,
            SATELLITE_GROUPS.starlink.color,
          ],
          'circle-opacity': [
            'match', ['get', 'group'],
            'iss', SATELLITE_GROUPS.iss.opacity,
            'gps', SATELLITE_GROUPS.gps.opacity,
            'station', SATELLITE_GROUPS.station.opacity,
            'geo', SATELLITE_GROUPS.geo.opacity,
            'debris', SATELLITE_GROUPS.debris.opacity,
            'active', SATELLITE_GROUPS.active.opacity,
            SATELLITE_GROUPS.starlink.opacity,
          ],
        },
      })

      // 5g. Satellites — ISS name label
      map.addLayer({
        id: 'satellites-label',
        type: 'symbol',
        source: 'satellites',
        filter: ['==', ['get', 'group'], 'iss'],
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Open Sans Semibold'],
          'text-size': 11,
          'text-offset': [0, 1.5],
          'text-anchor': 'top',
        },
        paint: {
          'text-color': SATELLITE_GROUPS.iss.color,
          'text-halo-color': 'rgba(0,0,0,0.8)',
          'text-halo-width': 1.5,
        },
      })

      // 5c. Terminator glow line (above borders for visibility)
      map.addLayer({
        id: 'terminator-border',
        type: 'line',
        source: 'terminator-curve',
        paint: {
          'line-color': 'rgba(100, 160, 255, 0.25)',
          'line-width': 1.5,
          'line-blur': 2,
        },
      })

      // 6. Country hover highlight
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

      // 7. Measure: rhumb straight line (dashed dark slate)
      map.addLayer({
        id: 'measure-straight',
        type: 'line',
        source: 'measure-straight-line',
        paint: {
          'line-color': '#475569',
          'line-width': 2,
          'line-dasharray': [4, 3],
          'line-opacity': 0.65,
        },
      })

      // 8. Measure: great circle arc (soft cyan)
      map.addLayer({
        id: 'measure-arc',
        type: 'line',
        source: 'measure-great-circle',
        paint: {
          'line-color': '#67E8F9',
          'line-width': 2.5,
          'line-opacity': 0.85,
        },
      })

      // 9. Measure point glow rings
      map.addLayer({
        id: 'measure-points-glow',
        type: 'circle',
        source: 'measure-points',
        paint: {
          'circle-radius': 11,
          'circle-color': 'rgba(255,255,255,0.12)',
          'circle-opacity': 1,
        },
      })

      // 10. Measure point inner dots
      map.addLayer({
        id: 'measure-points-inner',
        type: 'circle',
        source: 'measure-points',
        paint: {
          'circle-radius': 5,
          'circle-color': 'rgba(255,255,255,0.80)',
          'circle-stroke-width': 2,
          'circle-stroke-color': '#FFFFFF',
          'circle-stroke-opacity': 0.85,
        },
      })

      // 11. Antipode point glow rings
      map.addLayer({
        id: 'antipode-glow',
        type: 'circle',
        source: 'antipode-points',
        paint: {
          'circle-radius': 11,
          'circle-color': ['get', 'glowColor'],
          'circle-opacity': 1,
        },
      })

      // 12. Antipode point inner dots
      map.addLayer({
        id: 'antipode-inner',
        type: 'circle',
        source: 'antipode-points',
        paint: {
          'circle-radius': 5,
          'circle-color': ['get', 'color'],
          'circle-stroke-width': 2,
          'circle-stroke-color': '#FFFFFF',
          'circle-stroke-opacity': 0.85,
        },
      })

      // 13. Antipode connecting line (dashed, behind ghost)
      map.addLayer({
        id: 'antipode-connection',
        type: 'line',
        source: 'antipode-line',
        paint: {
          'line-color': '#94A3B8',
          'line-width': 1.5,
          'line-dasharray': [3, 3],
          'line-opacity': 0.5,
        },
      })

      // 14. Ghost country fill (top-most interactive layers)
      map.addLayer({
        id: 'ghost-fill',
        type: 'fill',
        source: 'ghost-country',
        paint: {
          'fill-color': '#FFFFFF',
          'fill-opacity': 0.45,
        },
      })

      // 15. Ghost country border
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

      // Update minZoom when the container is resized (e.g. browser window resize).
      // Skip in globe mode — globe has its own minZoom and the mercator formula doesn't apply.
      map.on('resize', () => {
        if (!globeModeRef.current) {
          map.setMinZoom(computeMinZoom(map.getContainer().offsetWidth))
        }
      })

      setIsMapLoaded(true)

      // Build geometry lookup for compare/ghost mode
      fetch('/ne_110m_countries.geojson')
        .then((r) => r.json())
        .then((geojson: FeatureCollection) => {
          const lookup: Record<string, Polygon | MultiPolygon> = {}
          for (const feature of geojson.features) {
            const iso =
              (feature.properties?.ISO_A3_EH as string) ||
              (feature.properties?.ISO_A3 as string)
            if (iso && iso !== '-99' && feature.geometry) {
              // Clip extreme-latitude vertices (e.g. Antarctica's south-pole
              // closure row at lat=-90°) so the ghost has no artificial flat bottom.
              lookup[iso] = clipGeometryToMercatorBounds(
                feature.geometry as Polygon | MultiPolygon,
              )
              const name = feature.properties?.NAME as string | undefined
              if (name) countryNameLookupRef.current[iso] = name
            }
          }
          countryGeoLookupRef.current = lookup
        })
        .catch((err) => console.error('Ghost geometry fetch failed:', err))

      // ── Auto-scroll ───────────────────────────────────────────────────────
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

      pauseAndResumeAfterRef.current = (ms: number) => {
        isPaused = true
        resumeAfter(ms)
      }

      const isAnyInteractiveMode = () =>
        compareModeRef.current || measureModeRef.current || antipodeModeRef.current

      const animate = (timestamp: number) => {
        if (!isPaused && !isAnyInteractiveMode()) {
          if (lastTimestamp !== null) {
            const elapsed = (timestamp - lastTimestamp) / 1000
            const center = map.getCenter()
            map.setCenter([center.lng + AUTO_SCROLL_SPEED * elapsed, center.lat])
          }
          lastTimestamp = timestamp
        } else if (isAnyInteractiveMode()) {
          lastTimestamp = null
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
        if (!isAnyInteractiveMode()) resumeAfter(5000)
      })
      map.on('touchstart', () => {
        isPaused = true
        lastTimestamp = null
        if (resumeTimer) clearTimeout(resumeTimer)
      })
      map.on('touchend', () => {
        if (!isAnyInteractiveMode()) resumeAfter(5000)
      })

      // ── Hover ─────────────────────────────────────────────────────────────
      map.on(
        'mousemove',
        'country-fills',
        (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
          if (!e.features || e.features.length === 0) return
          const feature = e.features[0]
          const id = feature.id as number

          if (hoveredIdRef.current !== null) {
            map.setFeatureState(
              { source: 'countries', id: Number(hoveredIdRef.current) },
              { hover: false },
            )
          }
          hoveredIdRef.current = String(id)
          map.setFeatureState({ source: 'countries', id }, { hover: true })

          if (!compareModeRef.current && !measureModeRef.current && !antipodeModeRef.current) {
            map.getCanvas().style.cursor = 'pointer'
          }

          // While dragging a ghost, suppress underlying country tooltips
          if (ghostStatusRef.current === 'dragging') return

          const name = feature.properties?.NAME || ''
          const iso =
            feature.properties?.ISO_A3_EH || feature.properties?.ISO_A3 || ''
          setTooltip({ visible: true, x: e.point.x, y: e.point.y, name, iso })
        },
      )

      map.on('mouseleave', 'country-fills', () => {
        if (hoveredIdRef.current !== null) {
          map.setFeatureState(
            { source: 'countries', id: Number(hoveredIdRef.current) },
            { hover: false },
          )
          hoveredIdRef.current = null
        }
        if (!compareModeRef.current && !measureModeRef.current && !antipodeModeRef.current) {
          map.getCanvas().style.cursor = ''
        }
        // Keep ghost name visible while dragging
        if (ghostStatusRef.current !== 'dragging') {
          setTooltip({ visible: false, x: 0, y: 0, name: '', iso: '' })
        }
      })

      // ── Ghost drag (compare mode) ─────────────────────────────────────────
      map.on('mousemove', (e: maplibregl.MapMouseEvent) => {
        if (!compareModeRef.current || ghostStatusRef.current !== 'dragging') return
        if (!ghostGeometryRef.current || !ghostCentroidRef.current) return

        const newCentroid = toMercator(e.lngLat.lng, e.lngLat.lat)
        const latOrig = fromMercator(
          ghostCentroidRef.current[0],
          ghostCentroidRef.current[1],
        )[1]
        const scale =
          Math.cos((latOrig * Math.PI) / 180) /
          Math.cos((e.lngLat.lat * Math.PI) / 180)

        const translated = repositionGeometry(
          ghostGeometryRef.current,
          ghostCentroidRef.current,
          newCentroid,
          scale,
        )
        const ghostSource = map.getSource('ghost-country') as maplibregl.GeoJSONSource
        ghostSource.setData(makeGhostFeatureCollection(translated, ghostNameRef.current))

        // Show only the ghost country's name while dragging
        setTooltip({ visible: true, x: e.point.x, y: e.point.y, name: ghostNameRef.current, iso: '' })
      })

      // ── Click on country fill ─────────────────────────────────────────────
      map.on(
        'click',
        'country-fills',
        (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
          if (!e.features || e.features.length === 0) return

          // Measure / antipode modes handled by the general click handler
          if (measureModeRef.current || antipodeModeRef.current) return

          const iso =
            e.features[0].properties?.ISO_A3_EH ||
            e.features[0].properties?.ISO_A3 ||
            null

          if (!compareModeRef.current) {
            setSelectedCountry(iso)
            return
          }

          // Compare mode: drop ghost if currently dragging
          if (ghostStatusRef.current === 'dragging') {
            ghostStatusRef.current = 'dropped'
            map.getCanvas().style.cursor = 'crosshair'
            setTooltip({ visible: false, x: 0, y: 0, name: '', iso: '' })
            return
          }

          if (!iso) return
          const geometry = countryGeoLookupRef.current[iso]
          if (!geometry) return

          const name = (e.features[0].properties?.NAME as string) || iso
          const centroid = computeMercatorCentroid(geometry)
          ghostGeometryRef.current = geometry
          ghostCentroidRef.current = centroid
          ghostNameRef.current = name
          ghostStatusRef.current = 'dragging'
          map.getCanvas().style.cursor = 'grabbing'

          const ghostSource = map.getSource('ghost-country') as maplibregl.GeoJSONSource
          ghostSource.setData(makeGhostFeatureCollection(geometry, name))
        },
      )

      // ── General click (ocean + measure + antipode) ────────────────────────
      map.on('click', (e: maplibregl.MapMouseEvent) => {
        const { lng, lat } = e.lngLat
        const features = map.queryRenderedFeatures(e.point, {
          layers: ['country-fills'],
        })

        // ── Measure mode ──────────────────────────────────────────────────
        if (measureModeRef.current) {
          const pts = measurePointsRef.current

          if (pts.length >= 2) {
            // Third+ click: start new measurement from this point
            measurePointsRef.current = [[lng, lat]]
            clearLayerSrc('measure-great-circle')
            clearLayerSrc('measure-straight-line')
            setMeasureInfo(null)
            updateMeasurePoints([[lng, lat]])
          } else {
            const newPts: [number, number][] = [...pts, [lng, lat]]
            measurePointsRef.current = newPts

            if (newPts.length === 2) {
              drawMeasurement(newPts[0], newPts[1])
            } else {
              updateMeasurePoints(newPts)
            }
          }
          return
        }

        // ── Antipode mode ─────────────────────────────────────────────────
        if (antipodeModeRef.current) {
          const antipodePt = computeAntipode(lng, lat)
          const [aLng, aLat] = antipodePt

          // Identify the country at the antipode via point-in-polygon.
          // queryRenderedFeatures is avoided here because in globe mode the
          // antipode is on the back face and won't be in the rendered viewport.
          const geoLookup = countryGeoLookupRef.current
          const nameLookup = countryNameLookupRef.current
          const matchedIso = Object.keys(geoLookup).find((iso) =>
            pointInCountry(aLng, aLat, geoLookup[iso]),
          )

          let label: string
          if (matchedIso && nameLookup[matchedIso]) {
            label = `In ${nameLookup[matchedIso]}!`
          } else {
            const ocean = identifyOcean(aLng, aLat)
            label = `In the ${ocean} Ocean`
          }

          const ptsSrc = map.getSource('antipode-points') as maplibregl.GeoJSONSource
          ptsSrc.setData({
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                properties: { color: '#FFFFFF', glowColor: 'rgba(255,255,255,0.12)' },
                geometry: { type: 'Point', coordinates: [lng, lat] },
              },
              {
                type: 'Feature',
                properties: { color: '#FCD34D', glowColor: 'rgba(251,191,36,0.20)' },
                geometry: { type: 'Point', coordinates: [aLng, aLat] },
              },
            ],
          })

          const lineSrc = map.getSource('antipode-line') as maplibregl.GeoJSONSource
          lineSrc.setData({
            type: 'FeatureCollection',
            features: [{
              type: 'Feature',
              properties: {},
              geometry: { type: 'LineString', coordinates: [[lng, lat], [aLng, aLat]] },
            }],
          })

          setAntipodeInfo({ origin: [lng, lat], antipodePt, label })
          return
        }

        // ── Normal / compare mode ─────────────────────────────────────────
        if (!compareModeRef.current) {
          if (features.length === 0) setSelectedCountry(null)
          return
        }

        // Compare mode: drop ghost on ocean click
        if (features.length === 0 && ghostStatusRef.current === 'dragging') {
          ghostStatusRef.current = 'dropped'
          map.getCanvas().style.cursor = 'crosshair'
          setTooltip({ visible: false, x: 0, y: 0, name: '', iso: '' })
        }
      })

      // ── Keyboard ──────────────────────────────────────────────────────────
      const handleKeyDown = (ev: KeyboardEvent) => {
        if (ev.key !== 'Escape') return
        setCompareMode(false)
        setMeasureMode(false)
        setAntipodeMode(false)
        setTerminatorVisible(false)
        setAuroraVisible(false)
      }
      window.addEventListener('keydown', handleKeyDown)

      const cleanup = () => {
        cancelAnimationFrame(animFrameId)
        if (resumeTimer) clearTimeout(resumeTimer)
        window.removeEventListener('keydown', handleKeyDown)
      }
      map.once('remove', cleanup)

      // ── Inner helpers ─────────────────────────────────────────────────────
      function clearLayerSrc(srcId: string) {
        ;(map.getSource(srcId) as maplibregl.GeoJSONSource | undefined)?.setData(
          EMPTY_FEATURE_COLLECTION,
        )
      }

      function updateMeasurePoints(pts: [number, number][]) {
        const src = map.getSource('measure-points') as maplibregl.GeoJSONSource
        src.setData({
          type: 'FeatureCollection',
          features: pts.map((p) => ({
            type: 'Feature',
            properties: {},
            geometry: { type: 'Point', coordinates: p },
          })),
        })
      }

      function drawMeasurement(p1: [number, number], p2: [number, number]) {
        const arcPts = interpolateGreatCircle(p1, p2, 100)

        const arcSrc = map.getSource('measure-great-circle') as maplibregl.GeoJSONSource
        arcSrc.setData({
          type: 'FeatureCollection',
          features: [{
            type: 'Feature',
            properties: {},
            geometry: { type: 'LineString', coordinates: unwrapPath(arcPts) },
          }],
        })

        const straightSrc = map.getSource(
          'measure-straight-line',
        ) as maplibregl.GeoJSONSource
        straightSrc.setData({
          type: 'FeatureCollection',
          features: [{
            type: 'Feature',
            properties: {},
            geometry: { type: 'LineString', coordinates: unwrapPath([p1, p2]) },
          }],
        })

        updateMeasurePoints([p1, p2])

        const midIdx = Math.floor(arcPts.length / 2)
        setMeasureInfo({
          distanceKm: haversineDistance(p1, p2),
          rhumbKm: rhumbDistance(p1, p2),
          midpoint: arcPts[midIdx],
        })
      }
    }) // end map.on('load')

    return () => {
      mapContainer.removeEventListener('wheel', handleWheel, { capture: true })
      map.remove()
      mapRef.current = null
      setIsMapLoaded(false)
    }
  }, [
    setTooltip,
    setSelectedCountry,
    setCompareMode,
    setMeasureMode,
    setAntipodeMode,
    setTerminatorVisible,
    setAuroraVisible,
    setMeasureInfo,
    setAntipodeInfo,
  ])

  // ─── Sync compareMode ────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !isMapLoaded) return

    compareModeRef.current = compareMode

    if (compareMode) {
      wasInCompareModeRef.current = true
      map.dragPan.disable()
      map.getCanvas().style.cursor = 'crosshair'
    } else {
      map.dragPan.enable()
      map.getCanvas().style.cursor = ''

      if (wasInCompareModeRef.current) {
        wasInCompareModeRef.current = false
        pauseAndResumeAfterRef.current?.(5000)
      }

      ghostStatusRef.current = 'none'
      ghostGeometryRef.current = null
      ghostCentroidRef.current = null
      ghostNameRef.current = ''
      const ghostSrc = map.getSource('ghost-country') as maplibregl.GeoJSONSource | undefined
      ghostSrc?.setData(EMPTY_FEATURE_COLLECTION)
    }
  }, [compareMode, isMapLoaded])

  // ─── Sync measureMode ────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !isMapLoaded) return

    measureModeRef.current = measureMode

    if (measureMode) {
      wasInMeasureModeRef.current = true
      map.dragPan.disable()
      map.getCanvas().style.cursor = 'crosshair'
    } else {
      map.dragPan.enable()
      map.getCanvas().style.cursor = ''

      if (wasInMeasureModeRef.current) {
        wasInMeasureModeRef.current = false
        pauseAndResumeAfterRef.current?.(5000)
      }

      measurePointsRef.current = []
      setMeasureInfo(null)
      const clearSrc = (id: string) =>
        (map.getSource(id) as maplibregl.GeoJSONSource | undefined)?.setData(
          EMPTY_FEATURE_COLLECTION,
        )
      clearSrc('measure-great-circle')
      clearSrc('measure-straight-line')
      clearSrc('measure-points')
    }
  }, [measureMode, isMapLoaded])

  // ─── Sync antipodeMode ───────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !isMapLoaded) return

    antipodeModeRef.current = antipodeMode

    if (antipodeMode) {
      wasInAntipodeModeRef.current = true
      map.dragPan.disable()
      map.getCanvas().style.cursor = 'crosshair'
    } else {
      map.dragPan.enable()
      map.getCanvas().style.cursor = ''

      if (wasInAntipodeModeRef.current) {
        wasInAntipodeModeRef.current = false
        pauseAndResumeAfterRef.current?.(5000)
      }

      setAntipodeInfo(null)
      const clearSrc = (id: string) =>
        (map.getSource(id) as maplibregl.GeoJSONSource | undefined)?.setData(
          EMPTY_FEATURE_COLLECTION,
        )
      clearSrc('antipode-points')
      clearSrc('antipode-line')
    }
  }, [antipodeMode, isMapLoaded])

  // ─── Sync globeMode ──────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !isMapLoaded) return

    globeModeRef.current = globeMode

    if (globeMode) {
      map.setProjection({ type: 'globe' })
      map.setMinZoom(0.5)
      map.easeTo({ zoom: 2.5, duration: 600 })
      // Let the zoom ease complete before rotation starts
      pauseAndResumeAfterRef.current?.(700)
    } else {
      map.setProjection({ type: 'mercator' })
      const restoredMin = computeMinZoom(map.getContainer().offsetWidth)
      map.setMinZoom(restoredMin)
      if (map.getZoom() < restoredMin) {
        map.easeTo({ zoom: restoredMin, duration: 200 })
      }
    }
  }, [globeMode, isMapLoaded])

  // ─── Submarine cables overlay ────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !isMapLoaded) return
    const src = map.getSource('submarine-cables') as maplibregl.GeoJSONSource | undefined
    if (!src) return

    if (!submarineCablesVisible) {
      src.setData(EMPTY_FEATURE_COLLECTION)
      return
    }

    // Use cached data if already fetched
    if (cablesGeoJSONRef.current) {
      src.setData(cablesGeoJSONRef.current as Parameters<typeof src.setData>[0])
      return
    }

    fetch('/data/submarine-cables.geojson')
      .then((r) => r.json())
      .then((geojson) => {
        cablesGeoJSONRef.current = geojson
        src.setData(geojson)
      })
      .catch((err) => console.error('Submarine cables fetch failed:', err))
  }, [submarineCablesVisible, isMapLoaded])

  // ─── Satellite overlay ──────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !isMapLoaded) return

    const satSrc = map.getSource('satellites') as maplibregl.GeoJSONSource | undefined
    const trailSrc = map.getSource('satellite-trail') as maplibregl.GeoJSONSource | undefined
    if (!satSrc || !trailSrc) return

    if (!satellitesVisible || !globeMode) {
      satSrc.setData(EMPTY_FEATURE_COLLECTION)
      trailSrc.setData(EMPTY_FEATURE_COLLECTION)
      if (satelliteIntervalRef.current !== null) {
        clearInterval(satelliteIntervalRef.current)
        satelliteIntervalRef.current = null
      }
      return
    }

    // Local SGP4 path — same as before, kept as the fallback when the WS server
    // is unreachable or drops the connection.
    const startLocal = () => {
      const sats = satelliteTLERef.current
      if (!sats || sats.length === 0) return
      const now = new Date()
      satSrc.setData(buildSatelliteGeoJSON(propagateAll(sats, now)))
      trailSrc.setData(buildISSTrail(sats, now))

      let trailTick = 0
      satelliteIntervalRef.current = window.setInterval(() => {
        const t = new Date()
        satSrc.setData(buildSatelliteGeoJSON(propagateAll(sats, t)))
        trailTick++
        if (trailTick >= 150) {
          trailTick = 0
          trailSrc.setData(buildISSTrail(sats, t))
        }
      }, 200)
    }

    const ensureLocalTLEsThenStart = () => {
      if (satelliteIntervalRef.current !== null) return // already running
      if (satelliteTLERef.current) {
        startLocal()
      } else {
        fetch('/data/satellites.json')
          .then((r) => r.json())
          .then((data: SatTLEEntry[]) => {
            satelliteTLERef.current = parseTLEData(data)
            // Only start if we're still in the "want satellites" state.
            if (satelliteIntervalRef.current === null) startLocal()
          })
          .catch((err) => console.error('Satellite data fetch failed:', err))
      }
    }

    // Viewport bounds helper. On the globe projection `map.getBounds()` returns
    // a Mercator-style box that doesn't track the actually-visible hemisphere,
    // so viewport culling would drop most of the catalog. The whole Earth is
    // always on screen in globe mode anyway, so we ship the full world.
    const currentViewport = (): ViewportBounds => {
      if (globeMode) {
        return { west: -180, south: -90, east: 180, north: 90 }
      }
      const b = map.getBounds()
      return {
        west: Math.max(-180, b.getWest()),
        south: Math.max(-90, b.getSouth()),
        east: Math.min(180, b.getEast()),
        north: Math.min(90, b.getNorth()),
      }
    }

    const wsUrl = import.meta.env.VITE_ORBIT_WS_URL as string | undefined

    let orbit: OrbitStreamHandle | null = null
    let usingWS = false
    let gotFirstBatch = false
    let fallbackTimer: number | null = null
    let moveendHandler: (() => void) | null = null
    let moveThrottle: number | null = null

    const clearFallbackTimer = () => {
      if (fallbackTimer !== null) {
        clearTimeout(fallbackTimer)
        fallbackTimer = null
      }
    }

    const stopLocal = () => {
      if (satelliteIntervalRef.current !== null) {
        clearInterval(satelliteIntervalRef.current)
        satelliteIntervalRef.current = null
      }
    }

    const renderWSPositions = (positions: SatPosition[]) => {
      satSrc.setData(buildSatelliteGeoJSON(positions))
      // ISS trail still comes from local TLEs — propagate one-off on first
      // WS batch so the gold arc is visible without keeping the 5 Hz loop alive.
      if (!gotFirstBatch) {
        gotFirstBatch = true
        stopLocal()
        const drawTrail = () => {
          const sats = satelliteTLERef.current
          if (sats && sats.length > 0) {
            trailSrc.setData(buildISSTrail(sats, new Date()))
          }
        }
        if (satelliteTLERef.current) {
          drawTrail()
        } else {
          fetch('/data/satellites.json')
            .then((r) => r.json())
            .then((data: SatTLEEntry[]) => {
              satelliteTLERef.current = parseTLEData(data)
              drawTrail()
            })
            .catch(() => {
              // Non-fatal — server positions already render without the trail.
            })
        }
      }
    }

    if (wsUrl) {
      orbit = connectOrbitStream(wsUrl, {
        onPositions: renderWSPositions,
        onConnect: () => {
          usingWS = true
          clearFallbackTimer()
          orbit?.updateViewport(currentViewport())
        },
        onDisconnect: () => {
          usingWS = false
          gotFirstBatch = false
          // Give the server ~3s to come back before falling back.
          clearFallbackTimer()
          fallbackTimer = window.setTimeout(() => {
            ensureLocalTLEsThenStart()
          }, 3000)
        },
      })

      // If the server never responds, fall back after 3s.
      fallbackTimer = window.setTimeout(() => {
        if (!gotFirstBatch) ensureLocalTLEsThenStart()
      }, 3000)

      // Sync viewport on pan/zoom (throttled to ~5 Hz).
      moveendHandler = () => {
        if (!usingWS || !orbit) return
        if (moveThrottle !== null) return
        moveThrottle = window.setTimeout(() => {
          moveThrottle = null
          orbit?.updateViewport(currentViewport())
        }, 200)
      }
      map.on('moveend', moveendHandler)
    } else {
      // No WS URL configured — local propagation only.
      ensureLocalTLEsThenStart()
    }

    return () => {
      clearFallbackTimer()
      if (moveThrottle !== null) {
        clearTimeout(moveThrottle)
        moveThrottle = null
      }
      if (moveendHandler) {
        map.off('moveend', moveendHandler)
      }
      if (orbit) {
        orbit.close()
        orbit = null
      }
      stopLocal()
    }
  }, [satellitesVisible, globeMode, isMapLoaded])

  // ─── Terminator overlay ──────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !isMapLoaded) return

    const src = map.getSource('terminator-shadow') as maplibregl.GeoJSONSource | undefined
    const curveSrc = map.getSource('terminator-curve') as maplibregl.GeoJSONSource | undefined
    if (!src || !curveSrc) return

    if (!terminatorVisible) {
      src.setData(EMPTY_FEATURE_COLLECTION)
      curveSrc.setData(EMPTY_FEATURE_COLLECTION)
      return
    }

    const update = () => {
      const now = new Date()
      src.setData(computeTerminator(now))
      curveSrc.setData(computeTerminatorCurve(now))
    }
    update()
    const interval = setInterval(update, 60_000)
    return () => clearInterval(interval)
  }, [terminatorVisible, isMapLoaded])

  // Keep a ref so the RAF closure always has the latest Kp without re-starting
  const auroraKpRef = useRef(aurora.kp)
  useEffect(() => {
    auroraKpRef.current = aurora.kp
  }, [aurora.kp])

  // ─── Aurora overlay A: real NOAA Ovation heatmap ─────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !isMapLoaded) return
    const src = map.getSource('aurora-ovation') as maplibregl.GeoJSONSource | undefined
    if (!src) return
    if (auroraVisible && aurora.ovationGeoJSON) {
      src.setData(aurora.ovationGeoJSON)
    } else {
      src.setData(EMPTY_FEATURE_COLLECTION)
    }
  }, [auroraVisible, aurora.ovationGeoJSON, isMapLoaded])

  // ─── Aurora overlay B: wavy bands fallback (when no real data) ───────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !isMapLoaded) return
    const src = map.getSource('aurora-bands') as maplibregl.GeoJSONSource | undefined
    if (!src) return

    // Only show wavy fallback after a confirmed fetch failure — never during loading
    const useFallback = auroraVisible && aurora.ovationFailed
    if (!useFallback) {
      src.setData(EMPTY_FEATURE_COLLECTION)
      return
    }

    let animId: number
    let phase = 0
    let lastTick = 0

    const animate = (ts: number) => {
      if (ts - lastTick > 80) { // ~12fps to avoid GPU thrash
        phase += 0.04
        src.setData(generateAuroraWavyBands(auroraKpRef.current, phase))
        lastTick = ts
      }
      animId = requestAnimationFrame(animate)
    }
    animId = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(animId)
  }, [auroraVisible, aurora.ovationFailed, isMapLoaded])

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="w-full h-full" />
      <DistanceLabel info={measureInfo} mapRef={mapRef} />
      <AntipodeLabel info={antipodeInfo} mapRef={mapRef} />
      {/* Projection pill toggle — bottom-center */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-10 flex rounded-lg border border-white/15 bg-black/50 backdrop-blur-sm overflow-hidden">
        {(['Flat', 'Globe'] as const).map((label) => {
          const active = label === 'Globe' ? globeMode : !globeMode
          return (
            <button
              key={label}
              onClick={() => setGlobeMode(label === 'Globe')}
              className={[
                'px-4 py-1.5 text-xs font-medium transition-all duration-200',
                active
                  ? 'bg-white/15 text-white'
                  : 'text-white/45 hover:text-white/75 hover:bg-white/5',
              ].join(' ')}
            >
              {label}
            </button>
          )
        })}
      </div>
      <div className="absolute bottom-8 right-3 z-10 flex flex-col gap-1">
        <button
          onClick={() => {
            const m = mapRef.current
            if (m) m.easeTo({ zoom: Math.min(m.getMaxZoom(), m.getZoom() + 2.0), duration: 300 })
          }}
          className="w-8 h-8 bg-black/50 border border-white/15 text-white/80 rounded text-lg leading-none hover:bg-white/10 transition-colors"
          aria-label="Zoom in"
        >+</button>
        <button
          onClick={() => {
            const m = mapRef.current
            if (m) m.easeTo({ zoom: Math.max(m.getMinZoom(), m.getZoom() - 2.0), duration: 300 })
          }}
          className="w-8 h-8 bg-black/50 border border-white/15 text-white/80 rounded text-lg leading-none hover:bg-white/10 transition-colors"
          aria-label="Zoom out"
        >–</button>
      </div>
    </div>
  )
}
