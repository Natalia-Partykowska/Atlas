import { create } from 'zustand'
import type { AtlasState, TooltipState, LayerId, CountryDataMap } from '@/types/atlas'

export const useAtlasStore = create<AtlasState>((set) => ({
  tooltip: { visible: false, x: 0, y: 0, name: '', iso: '' },
  selectedCountry: null,
  activeLayerId: 'gdp',
  layerData: null,
  compareMode: false,
  measureMode: false,
  antipodeMode: false,
  terminatorVisible: false,
  auroraVisible: false,
  auroraKp: 2,
  auroraLabel: 'Quiet',
  auroraDataUnavailable: false,
  setTooltip: (tooltip: TooltipState) => set({ tooltip }),
  setSelectedCountry: (selectedCountry) => set({ selectedCountry }),
  setActiveLayerId: (activeLayerId: LayerId) => set({ activeLayerId }),
  setLayerData: (layerData: CountryDataMap | null) => set({ layerData }),
  // Mutually exclusive interactive modes
  setCompareMode: (on: boolean) =>
    set(on ? { compareMode: true, measureMode: false, antipodeMode: false } : { compareMode: false }),
  setMeasureMode: (on: boolean) =>
    set(on ? { measureMode: true, compareMode: false, antipodeMode: false } : { measureMode: false }),
  setAntipodeMode: (on: boolean) =>
    set(on ? { antipodeMode: true, compareMode: false, measureMode: false } : { antipodeMode: false }),
  // Independent overlay toggles
  setTerminatorVisible: (terminatorVisible: boolean) => set({ terminatorVisible }),
  setAuroraVisible: (auroraVisible: boolean) => set({ auroraVisible }),
  setAuroraInfo: (auroraKp, auroraLabel, auroraDataUnavailable) =>
    set({ auroraKp, auroraLabel, auroraDataUnavailable }),
}))
