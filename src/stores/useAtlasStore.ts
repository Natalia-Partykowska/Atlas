import { create } from 'zustand'
import type {
  AtlasState,
  TooltipState,
  LayerId,
  CountryDataMap,
  SatelliteHoverState,
} from '@/types/atlas'
import type { ConjunctionEvent } from '@/lib/orbitStream'
import { mergeConjunctionEvents, pruneConjunctionEvents } from '@/lib/conjunctionEvents'
import type { SatelliteCatalogEntry } from '@/lib/satelliteCatalog'
import { readVoiceEnabled, writeVoiceEnabled } from '@/lib/satelliteVoice'
import { SATELLITE_FEED_OFF } from '@/lib/satelliteFeed'

const EMPTY_SATELLITE_HOVER: SatelliteHoverState = {
  visible: false,
  x: 0,
  y: 0,
  norad: 0,
  name: '',
}

export const useAtlasStore = create<AtlasState>((set, get) => ({
  tooltip: { visible: false, x: 0, y: 0, name: '', iso: '' },
  selectedCountry: null,
  activeLayerId: 'base',
  layerData: null,
  compareMode: false,
  measureMode: false,
  antipodeMode: false,
  globeMode: true,
  submarineCablesVisible: false,
  satellitesVisible: false,
  satelliteCount: 0,
  satelliteFeed: SATELLITE_FEED_OFF,
  satelliteRetryRequest: 0,
  conjunctionsVisible: false,
  conjunctionEvents: [],
  selectedConjunction: null,
  conjunctionsReceivedFirstBatch: false,
  satelliteCatalog: null,
  satelliteHover: EMPTY_SATELLITE_HOVER,
  selectedSatellite: null,
  satelliteVoiceEnabled: readVoiceEnabled(),
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
  // Catalog + hover + selection are also cleared so a re-enable starts fresh.
  setSatellitesVisible: (on: boolean) =>
    set(
      on
        ? { satellitesVisible: true }
        : {
            satellitesVisible: false,
            satelliteCount: 0,
            satelliteFeed: SATELLITE_FEED_OFF,
            conjunctionsVisible: false,
            conjunctionEvents: [],
            selectedConjunction: null,
            conjunctionsReceivedFirstBatch: false,
            satelliteCatalog: null,
            satelliteHover: EMPTY_SATELLITE_HOVER,
            selectedSatellite: null,
          },
    ),
  setSatelliteCount: (satelliteCount: number) => set({ satelliteCount }),
  setSatelliteFeed: (satelliteFeed) => set({ satelliteFeed }),
  requestSatelliteRetry: () =>
    set((s) => ({ satelliteRetryRequest: s.satelliteRetryRequest + 1 })),
  // Enabling conjunctions force-enables globe + satellites; disabling clears state.
  // Either transition empties the list and resets the "received first batch"
  // flag, so the drawer shows a fresh "Loading…" (and no count) until the next
  // 0.1 Hz tick lands.
  setConjunctionsVisible: (on: boolean) =>
    set(
      on
        ? {
            conjunctionsVisible: true,
            globeMode: true,
            satellitesVisible: true,
            conjunctionEvents: [],
            conjunctionsReceivedFirstBatch: false,
          }
        : {
            conjunctionsVisible: false,
            conjunctionEvents: [],
            selectedConjunction: null,
            conjunctionsReceivedFirstBatch: false,
          },
    ),
  // Each 10 s batch is merged into the list rather than replacing it (see
  // `conjunctionEvents.ts`): rows stay until their closest approach has passed
  // and the selected pair stays until deselected. Also flips
  // `receivedFirstBatch` true so the panel can switch from "Loading…" to
  // either the row list or "No close approaches".
  // Batches keep streaming while the drawer is closed; they're ignored, so
  // opening it never shows an old batch's count before a fresh one lands.
  mergeConjunctionBatch: (events: ConjunctionEvent[]) => {
    const { conjunctionsVisible, conjunctionEvents, selectedConjunction } = get()
    if (!conjunctionsVisible) return
    set({
      conjunctionEvents: mergeConjunctionEvents(
        conjunctionEvents,
        events,
        Date.now(),
        selectedConjunction,
      ),
      conjunctionsReceivedFirstBatch: true,
    })
  },
  // The server is gone (or we fell back to local positions): no screening, so
  // empty the list and drop the selection. An empty batch can't do this any
  // more — merging keeps what's there. Also ends any "Loading…": with no
  // server there's nothing to wait for.
  clearConjunctionEvents: () =>
    set({
      conjunctionEvents: [],
      selectedConjunction: null,
      conjunctionsReceivedFirstBatch: true,
    }),
  // Selecting a conjunction clears any in-flight satellite selection (mutually
  // exclusive — one drawer at a time, one camera target at a time). Letting go
  // drops a row that stayed past its closest approach only while selected.
  setSelectedConjunction: (selectedConjunction) =>
    set(
      selectedConjunction
        ? { selectedConjunction, selectedSatellite: null }
        : {
            selectedConjunction: null,
            conjunctionEvents: pruneConjunctionEvents(get().conjunctionEvents, Date.now(), null),
          },
    ),
  setSatelliteCatalog: (satelliteCatalog: Map<number, SatelliteCatalogEntry> | null) =>
    set({ satelliteCatalog }),
  setSatelliteHover: (satelliteHover: SatelliteHoverState) => set({ satelliteHover }),
  // Selecting a satellite clears any in-flight conjunction selection (mutually
  // exclusive — see setSelectedConjunction), which lets go of its row too.
  setSelectedSatellite: (selectedSatellite) =>
    set(
      selectedSatellite
        ? {
            selectedSatellite,
            selectedConjunction: null,
            conjunctionEvents: pruneConjunctionEvents(get().conjunctionEvents, Date.now(), null),
          }
        : { selectedSatellite: null },
    ),
  setSatelliteVoiceEnabled: (on: boolean) => {
    writeVoiceEnabled(on)
    set({ satelliteVoiceEnabled: on })
  },
  // Overlay toggles — switching on also moves to base layer
  setTerminatorVisible: (on: boolean) =>
    set(on ? { terminatorVisible: true, activeLayerId: 'base' } : { terminatorVisible: false }),
  setAuroraVisible: (on: boolean) =>
    set(on ? { auroraVisible: true, activeLayerId: 'base' } : { auroraVisible: false }),
  setAuroraInfo: (auroraKp, auroraLabel, auroraDataUnavailable) =>
    set({ auroraKp, auroraLabel, auroraDataUnavailable }),
}))
