export type ISO3 = string
export type CountryDataMap = Record<ISO3, number>

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
  setTooltip: (tooltip: TooltipState) => void
  setSelectedCountry: (country: string | null) => void
}
