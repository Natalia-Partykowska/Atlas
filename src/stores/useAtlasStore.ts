import { create } from 'zustand'
import type { AtlasState, TooltipState, LayerId, CountryDataMap } from '@/types/atlas'
import type { ConjunctionEvent } from '@/lib/orbitStream'

export const useAtlasStore = create<AtlasState>((set, get) => ({
  tooltip: { visible: false, x: 0, y: 0, name: '', iso: '' },
  selectedCountry: null,
  activeLayerId: 'base',
  layerData: null,
  compareMode: false,
  measureMode: false,
  antipodeMode: false,
  globeMode: false,
  submarineCablesVisible: false,
  satellitesVisible: false,
  conjunctionsVisible: false,
  conjunctionEvents: [],
  selectedConjunction: null,
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
  setGlobeMode: (on: boolean) =>
    set(on ? { globeMode: true, compareMode: false, measureMode: false, antipodeMode: false } : { globeMode: false }),
  setSubmarineCablesVisible: (on: boolean) =>
    set({ submarineCablesVisible: on }),
  // Disabling satellites cascades conjunctions off and clears their state.
  setSatellitesVisible: (on: boolean) =>
    set(
      on
        ? { satellitesVisible: true }
        : {
            satellitesVisible: false,
            conjunctionsVisible: false,
            conjunctionEvents: [],
            selectedConjunction: null,
          },
    ),
  // Enabling conjunctions force-enables globe + satellites; disabling clears state.
  setConjunctionsVisible: (on: boolean) =>
    set(
      on
        ? { conjunctionsVisible: true, globeMode: true, satellitesVisible: true }
        : { conjunctionsVisible: false, conjunctionEvents: [], selectedConjunction: null },
    ),
  // Replacing the events list also drops the selection if the chosen pair is gone.
  setConjunctionEvents: (events: ConjunctionEvent[]) => {
    const sel = get().selectedConjunction
    if (
      sel &&
      !events.some(
        (e) =>
          (e.noradA === sel.noradA && e.noradB === sel.noradB) ||
          (e.noradA === sel.noradB && e.noradB === sel.noradA),
      )
    ) {
      set({ conjunctionEvents: events, selectedConjunction: null })
    } else {
      set({ conjunctionEvents: events })
    }
  },
  setSelectedConjunction: (selectedConjunction) => set({ selectedConjunction }),
  // Overlay toggles — switching on also moves to base layer
  setTerminatorVisible: (on: boolean) =>
    set(on ? { terminatorVisible: true, activeLayerId: 'base' } : { terminatorVisible: false }),
  setAuroraVisible: (on: boolean) =>
    set(on ? { auroraVisible: true, activeLayerId: 'base' } : { auroraVisible: false }),
  setAuroraInfo: (auroraKp, auroraLabel, auroraDataUnavailable) =>
    set({ auroraKp, auroraLabel, auroraDataUnavailable }),
}))
