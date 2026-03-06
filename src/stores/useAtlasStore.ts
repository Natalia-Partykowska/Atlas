import { create } from 'zustand'
import type { AtlasState, TooltipState, LayerId, CountryDataMap } from '@/types/atlas'

export const useAtlasStore = create<AtlasState>((set) => ({
  tooltip: { visible: false, x: 0, y: 0, name: '', iso: '' },
  selectedCountry: null,
  activeLayerId: 'base',
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
  // Mutually exclusive interactive modes — switching on also moves to base layer
  setCompareMode: (on: boolean) =>
    set(on ? { compareMode: true, measureMode: false, antipodeMode: false, activeLayerId: 'base' } : { compareMode: false }),
  setMeasureMode: (on: boolean) =>
    set(on ? { measureMode: true, compareMode: false, antipodeMode: false, activeLayerId: 'base' } : { measureMode: false }),
  setAntipodeMode: (on: boolean) =>
    set(on ? { antipodeMode: true, compareMode: false, measureMode: false, activeLayerId: 'base' } : { antipodeMode: false }),
  // Overlay toggles — switching on also moves to base layer
  setTerminatorVisible: (on: boolean) =>
    set(on ? { terminatorVisible: true, activeLayerId: 'base' } : { terminatorVisible: false }),
  setAuroraVisible: (on: boolean) =>
    set(on ? { auroraVisible: true, activeLayerId: 'base' } : { auroraVisible: false }),
  setAuroraInfo: (auroraKp, auroraLabel, auroraDataUnavailable) =>
    set({ auroraKp, auroraLabel, auroraDataUnavailable }),
}))
