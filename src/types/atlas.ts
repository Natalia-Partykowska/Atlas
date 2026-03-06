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

export interface AtlasState {
  tooltip: TooltipState
  selectedCountry: string | null
  activeLayerId: LayerId
  layerData: CountryDataMap | null
  compareMode: boolean
  measureMode: boolean
  antipodeMode: boolean
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
  setTerminatorVisible: (on: boolean) => void
  setAuroraVisible: (on: boolean) => void
  setAuroraInfo: (kp: number, label: string, dataUnavailable: boolean) => void
}
