import type { ConjunctionEvent } from '@/lib/orbitStream'
import type { SatelliteCatalogEntry } from '@/lib/satelliteCatalog'

export type ISO3 = string
export type CountryDataMap = Record<ISO3, number>

export type LayerId = 'base' | 'gdp' | 'hdi' | 'happiness' | 'mobile-desktop' | 'ai-adoption'

export interface BaseLayerConfig {
  id: 'base'
  label: string
  description: string
}

export interface DataLayerConfig {
  id: Exclude<LayerId, 'base'>
  label: string
  description: string
  unit: string
  dataFile: string
  colorLow: string
  colorHigh: string
  format: (v: number) => string
}

export type LayerConfig = BaseLayerConfig | DataLayerConfig

export interface TooltipState {
  visible: boolean
  x: number
  y: number
  name: string
  iso: string
}

export interface SatelliteHoverState {
  visible: boolean
  x: number
  y: number
  norad: number
  name: string
}

export interface AtlasState {
  tooltip: TooltipState
  selectedCountry: string | null
  activeLayerId: LayerId
  layerData: CountryDataMap | null
  compareMode: boolean
  measureMode: boolean
  antipodeMode: boolean
  globeMode: boolean
  submarineCablesVisible: boolean
  satellitesVisible: boolean
  // Live count of satellites in the most recent position frame (WS or local
  // fallback). Reset to 0 when the satellite layer is disabled or the WS
  // mode goes idle. Surfaced in the top-left BrandStrip live readout.
  satelliteCount: number
  conjunctionsVisible: boolean
  conjunctionEvents: ConjunctionEvent[]
  selectedConjunction: { noradA: number; noradB: number } | null
  satelliteCatalog: Map<number, SatelliteCatalogEntry> | null
  satelliteHover: SatelliteHoverState
  selectedSatellite: { norad: number } | null
  // Distinguishes "loading" (drawer open, awaiting first 0.1 Hz batch) from
  // "really empty" (server reported zero events). Goes false when the user
  // toggles the drawer on; goes true when any event batch arrives.
  conjunctionsReceivedFirstBatch: boolean
  terminatorVisible: boolean
  auroraVisible: boolean
  auroraKp: number
  auroraLabel: string
  auroraDataUnavailable: boolean
  setTooltip: (tooltip: TooltipState) => void
  setSelectedCountry: (country: string | null) => void
  setActiveLayerId: (id: LayerId) => void
  setLayerData: (data: CountryDataMap | null) => void
  setCompareMode: (on: boolean) => void
  setMeasureMode: (on: boolean) => void
  setAntipodeMode: (on: boolean) => void
  setGlobeMode: (on: boolean) => void
  setSubmarineCablesVisible: (on: boolean) => void
  setSatellitesVisible: (on: boolean) => void
  setSatelliteCount: (n: number) => void
  setConjunctionsVisible: (on: boolean) => void
  setConjunctionEvents: (events: ConjunctionEvent[]) => void
  setSelectedConjunction: (sel: { noradA: number; noradB: number } | null) => void
  setSatelliteCatalog: (catalog: Map<number, SatelliteCatalogEntry> | null) => void
  setSatelliteHover: (hover: SatelliteHoverState) => void
  setSelectedSatellite: (sel: { norad: number } | null) => void
  setTerminatorVisible: (on: boolean) => void
  setAuroraVisible: (on: boolean) => void
  setAuroraInfo: (kp: number, label: string, dataUnavailable: boolean) => void
}
