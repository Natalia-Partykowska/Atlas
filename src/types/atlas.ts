export type ISO3 = string
export type CountryDataMap = Record<ISO3, number>

export type LayerId = 'gdp' | 'hdi' | 'happiness' | 'mobile-desktop' | 'ai-adoption'

export interface LayerConfig {
  id: LayerId
  label: string
  description: string
  unit: string
  dataFile: string
  colorLow: string
  colorHigh: string
  format: (v: number) => string
}

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
  setTooltip: (tooltip: TooltipState) => void
  setSelectedCountry: (country: string | null) => void
  setActiveLayerId: (id: LayerId) => void
  setLayerData: (data: CountryDataMap | null) => void
  setCompareMode: (on: boolean) => void
}
