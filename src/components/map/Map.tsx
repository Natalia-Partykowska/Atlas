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
  EMPTY_FEATURE_COLLECTION,
} from '@/lib/ghostGeometry'
import {
  interpolateGreatCircle,
  haversineDistance,
  rhumbDistance,
  unwrapPath,
  splitAtAntiMeridian,
} from '@/lib/greatCircle'
import { generateAuroraWavyBands } from '@/lib/aurora'
import { computeAntipode, identifyOcean } from '@/lib/antipode'
import { computeTerminator, computeTerminatorCurve } from '@/lib/solarTerminator'
import DistanceLabel from '@/components/overlays/DistanceLabel'
import AntipodeLabel from '@/components/overlays/AntipodeLabel'
import type { AntipodeInfo } from '@/components/overlays/AntipodeLabel'

const COLORS = {
  ocean: '#0D1929',
  border: '#2A3A4E',
}

const AUTO_SCROLL_SPEED = 4

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

  const setTooltip = useAtlasStore((s) => s.setTooltip)
  const setSelectedCountry = useAtlasStore((s) => s.setSelectedCountry)
  const compareMode = useAtlasStore((s) => s.compareMode)
  const setCompareMode = useAtlasStore((s) => s.setCompareMode)
  const measureMode = useAtlasStore((s) => s.measureMode)
  const setMeasureMode = useAtlasStore((s) => s.setMeasureMode)
  const antipodeMode = useAtlasStore((s) => s.antipodeMode)
  const setAntipodeMode = useAtlasStore((s) => s.setAntipodeMode)
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

      // 5. Terminator glow line (above borders for visibility)
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
              lookup[iso] = feature.geometry as Polygon | MultiPolygon
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
        setTooltip({ visible: false, x: 0, y: 0, name: '', iso: '' })
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

          // Detect what's at the antipode using queryRenderedFeatures
          const aScreen = map.project(new maplibregl.LngLat(aLng, aLat))
          const aFeatures = map.queryRenderedFeatures(aScreen, {
            layers: ['country-fills'],
          })

          let label: string
          if (aFeatures.length > 0) {
            const cName = aFeatures[0].properties?.NAME || 'a country'
            label = `In ${cName}!`
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
        const segments = splitAtAntiMeridian(unwrapPath(arcPts))

        const arcSrc = map.getSource('measure-great-circle') as maplibregl.GeoJSONSource
        arcSrc.setData({
          type: 'FeatureCollection',
          features: segments.map((seg) => ({
            type: 'Feature',
            properties: {},
            geometry: { type: 'LineString', coordinates: seg },
          })),
        })

        const straightSrc = map.getSource(
          'measure-straight-line',
        ) as maplibregl.GeoJSONSource
        straightSrc.setData({
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: {},
              geometry: { type: 'LineString', coordinates: [p1, p2] },
            },
          ],
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

    const useFallback = auroraVisible && !aurora.ovationGeoJSON
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
  }, [auroraVisible, aurora.ovationGeoJSON, isMapLoaded])

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="w-full h-full" />
      <DistanceLabel info={measureInfo} mapRef={mapRef} />
      <AntipodeLabel info={antipodeInfo} mapRef={mapRef} />
      <div className="absolute bottom-8 right-3 z-10 flex flex-col gap-1">
        <button
          onClick={() => {
            const m = mapRef.current
            if (m) m.easeTo({ zoom: Math.min(m.getMaxZoom(), m.getZoom() + 1.2), duration: 300 })
          }}
          className="w-8 h-8 bg-black/50 border border-white/15 text-white/80 rounded text-lg leading-none hover:bg-white/10 transition-colors"
          aria-label="Zoom in"
        >+</button>
        <button
          onClick={() => {
            const m = mapRef.current
            if (m) m.easeTo({ zoom: Math.max(m.getMinZoom(), m.getZoom() - 1.2), duration: 300 })
          }}
          className="w-8 h-8 bg-black/50 border border-white/15 text-white/80 rounded text-lg leading-none hover:bg-white/10 transition-colors"
          aria-label="Zoom out"
        >–</button>
      </div>
    </div>
  )
}
