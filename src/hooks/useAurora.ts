import { useEffect, useState } from 'react'
import type { FeatureCollection, Point } from 'geojson'
import { kpLabel, kpColor, convertOvationToGeoJSON } from '@/lib/aurora'
import type { OvationData } from '@/lib/aurora'

const NOAA_KP_URL =
  'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json'
const NOAA_OVATION_URL =
  'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json'
const POLL_INTERVAL_MS = 15 * 60 * 1000 // 15 minutes
const DEFAULT_KP = 2

interface AuroraState {
  kp: number
  label: string
  color: string
  dataUnavailable: boolean
  ovationGeoJSON: FeatureCollection<Point> | null
}

export function useAurora(enabled: boolean): AuroraState {
  const [kp, setKp] = useState(DEFAULT_KP)
  const [dataUnavailable, setDataUnavailable] = useState(false)
  const [ovationGeoJSON, setOvationGeoJSON] = useState<FeatureCollection<Point> | null>(null)

  useEffect(() => {
    if (!enabled) {
      setOvationGeoJSON(null)
      return
    }

    const fetchKp = async () => {
      try {
        const res = await fetch(NOAA_KP_URL)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data: unknown[][] = await res.json()
        // data = [[timestamp, kp, ...], ...] — first row is headers
        const rows = data.slice(1)
        if (rows.length === 0) throw new Error('Empty response')
        const latest = rows[rows.length - 1]
        const kpValue = parseFloat(String(latest[1]))
        if (isNaN(kpValue)) throw new Error('Invalid Kp value')
        setKp(kpValue)
        setDataUnavailable(false)
      } catch {
        setDataUnavailable(true)
        // Keep last known Kp (or default)
      }
    }

    const fetchOvation = async () => {
      try {
        const res = await fetch(NOAA_OVATION_URL)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data: OvationData = await res.json()
        setOvationGeoJSON(convertOvationToGeoJSON(data))
      } catch {
        setOvationGeoJSON(null)
      }
    }

    fetchKp()
    fetchOvation()
    const interval = setInterval(() => {
      fetchKp()
      fetchOvation()
    }, POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [enabled])

  return {
    kp,
    label: kpLabel(kp),
    color: kpColor(kp),
    dataUnavailable,
    ovationGeoJSON,
  }
}
