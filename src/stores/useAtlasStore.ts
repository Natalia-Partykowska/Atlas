import { create } from 'zustand'
import type { AtlasState, TooltipState, LayerId, CountryDataMap } from '@/types/atlas'

export const useAtlasStore = create<AtlasState>((set) => ({
  tooltip: { visible: false, x: 0, y: 0, name: '', iso: '' },
  selectedCountry: null,
  activeLayerId: 'gdp',
  layerData: null,
  setTooltip: (tooltip: TooltipState) => set({ tooltip }),
  setSelectedCountry: (selectedCountry) => set({ selectedCountry }),
  setActiveLayerId: (activeLayerId: LayerId) => set({ activeLayerId }),
  setLayerData: (layerData: CountryDataMap | null) => set({ layerData }),
}))
