import { create } from 'zustand'
import type { AtlasState, TooltipState } from '@/types/atlas'

export const useAtlasStore = create<AtlasState>((set) => ({
  tooltip: { visible: false, x: 0, y: 0, name: '', iso: '' },
  selectedCountry: null,
  setTooltip: (tooltip: TooltipState) => set({ tooltip }),
  setSelectedCountry: (selectedCountry) => set({ selectedCountry }),
}))
