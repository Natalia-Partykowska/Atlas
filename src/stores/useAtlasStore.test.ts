import { describe, it, expect, beforeEach } from 'vitest'
import { createStore } from 'zustand/vanilla'
import type { AtlasState, TooltipState } from '@/types/atlas'

// ── Recreate a fresh store for every test ─────────────────────────────────────
// We use zustand/vanilla so there's no React dependency.
// The factory mirrors useAtlasStore.ts exactly.

function makeStore() {
  return createStore<AtlasState>((set) => ({
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
    terminatorVisible: false,
    auroraVisible: false,
    auroraKp: 2,
    auroraLabel: 'Quiet',
    auroraDataUnavailable: false,
    setTooltip: (tooltip: TooltipState) => set({ tooltip }),
    setSelectedCountry: (selectedCountry) => set({ selectedCountry }),
    setActiveLayerId: (activeLayerId) => set({ activeLayerId }),
    setLayerData: (layerData) => set({ layerData }),
    setCompareMode: (on: boolean) =>
      set(on ? { compareMode: true, measureMode: false, antipodeMode: false, activeLayerId: 'base' } : { compareMode: false }),
    setMeasureMode: (on: boolean) =>
      set(on ? { measureMode: true, compareMode: false, antipodeMode: false, activeLayerId: 'base' } : { measureMode: false }),
    setAntipodeMode: (on: boolean) =>
      set(on ? { antipodeMode: true, compareMode: false, measureMode: false, activeLayerId: 'base' } : { antipodeMode: false }),
    setGlobeMode: (on: boolean) =>
      set(on ? { globeMode: true, compareMode: false, measureMode: false, antipodeMode: false } : { globeMode: false }),
    setSubmarineCablesVisible: (on: boolean) => set({ submarineCablesVisible: on }),
    setSatellitesVisible: (on: boolean) => set({ satellitesVisible: on }),
    setTerminatorVisible: (on: boolean) =>
      set(on ? { terminatorVisible: true, activeLayerId: 'base' } : { terminatorVisible: false }),
    setAuroraVisible: (on: boolean) =>
      set(on ? { auroraVisible: true, activeLayerId: 'base' } : { auroraVisible: false }),
    setAuroraInfo: (auroraKp, auroraLabel, auroraDataUnavailable) =>
      set({ auroraKp, auroraLabel, auroraDataUnavailable }),
  }))
}

type Store = ReturnType<typeof makeStore>
let store: Store

beforeEach(() => {
  store = makeStore()
})

const get = () => store.getState()

// ── Initial state ─────────────────────────────────────────────────────────────

describe('initial state', () => {
  it('starts with base layer active', () => {
    expect(get().activeLayerId).toBe('base')
  })

  it('all modes are off', () => {
    const s = get()
    expect(s.compareMode).toBe(false)
    expect(s.measureMode).toBe(false)
    expect(s.antipodeMode).toBe(false)
    expect(s.globeMode).toBe(false)
  })

  it('all overlays are off', () => {
    const s = get()
    expect(s.terminatorVisible).toBe(false)
    expect(s.auroraVisible).toBe(false)
    expect(s.submarineCablesVisible).toBe(false)
    expect(s.satellitesVisible).toBe(false)
  })

  it('tooltip is hidden', () => {
    expect(get().tooltip.visible).toBe(false)
  })

  it('auroraKp starts at 2 with label Quiet', () => {
    expect(get().auroraKp).toBe(2)
    expect(get().auroraLabel).toBe('Quiet')
  })
})

// ── setCompareMode ────────────────────────────────────────────────────────────

describe('setCompareMode', () => {
  it('turns compareMode on', () => {
    get().setCompareMode(true)
    expect(get().compareMode).toBe(true)
  })

  it('forces activeLayerId to base when turning on', () => {
    get().setActiveLayerId('gdp')
    get().setCompareMode(true)
    expect(get().activeLayerId).toBe('base')
  })

  it('turns off measureMode when turning on', () => {
    get().setMeasureMode(true)
    get().setCompareMode(true)
    expect(get().measureMode).toBe(false)
  })

  it('turns off antipodeMode when turning on', () => {
    get().setAntipodeMode(true)
    get().setCompareMode(true)
    expect(get().antipodeMode).toBe(false)
  })

  it('turning off only sets compareMode false — does not touch other state', () => {
    get().setActiveLayerId('hdi')
    get().setCompareMode(false)
    expect(get().compareMode).toBe(false)
    expect(get().activeLayerId).toBe('hdi') // unchanged
  })
})

// ── setMeasureMode ────────────────────────────────────────────────────────────

describe('setMeasureMode', () => {
  it('turns measureMode on', () => {
    get().setMeasureMode(true)
    expect(get().measureMode).toBe(true)
  })

  it('forces activeLayerId to base when turning on', () => {
    get().setActiveLayerId('happiness')
    get().setMeasureMode(true)
    expect(get().activeLayerId).toBe('base')
  })

  it('turns off compareMode when turning on', () => {
    get().setCompareMode(true)
    get().setMeasureMode(true)
    expect(get().compareMode).toBe(false)
  })

  it('turns off antipodeMode when turning on', () => {
    get().setAntipodeMode(true)
    get().setMeasureMode(true)
    expect(get().antipodeMode).toBe(false)
  })

  it('turning off only sets measureMode false', () => {
    get().setActiveLayerId('gdp')
    get().setMeasureMode(false)
    expect(get().measureMode).toBe(false)
    expect(get().activeLayerId).toBe('gdp')
  })
})

// ── setAntipodeMode ───────────────────────────────────────────────────────────

describe('setAntipodeMode', () => {
  it('turns antipodeMode on', () => {
    get().setAntipodeMode(true)
    expect(get().antipodeMode).toBe(true)
  })

  it('forces activeLayerId to base when turning on', () => {
    get().setActiveLayerId('ai-adoption')
    get().setAntipodeMode(true)
    expect(get().activeLayerId).toBe('base')
  })

  it('turns off compareMode when turning on', () => {
    get().setCompareMode(true)
    get().setAntipodeMode(true)
    expect(get().compareMode).toBe(false)
  })

  it('turns off measureMode when turning on', () => {
    get().setMeasureMode(true)
    get().setAntipodeMode(true)
    expect(get().measureMode).toBe(false)
  })

  it('turning off only sets antipodeMode false', () => {
    get().setActiveLayerId('hdi')
    get().setAntipodeMode(false)
    expect(get().antipodeMode).toBe(false)
    expect(get().activeLayerId).toBe('hdi')
  })
})

// ── setGlobeMode ──────────────────────────────────────────────────────────────

describe('setGlobeMode', () => {
  it('turns globeMode on', () => {
    get().setGlobeMode(true)
    expect(get().globeMode).toBe(true)
  })

  it('does NOT force activeLayerId to base (data layers render on globe)', () => {
    get().setActiveLayerId('gdp')
    get().setGlobeMode(true)
    expect(get().activeLayerId).toBe('gdp')
  })

  it('turns off compareMode when turning on', () => {
    get().setCompareMode(true)
    get().setGlobeMode(true)
    expect(get().compareMode).toBe(false)
  })

  it('turns off measureMode when turning on', () => {
    get().setMeasureMode(true)
    get().setGlobeMode(true)
    expect(get().measureMode).toBe(false)
  })

  it('turns off antipodeMode when turning on', () => {
    get().setAntipodeMode(true)
    get().setGlobeMode(true)
    expect(get().antipodeMode).toBe(false)
  })

  it('turning off only sets globeMode false — layer unchanged', () => {
    get().setActiveLayerId('hdi')
    get().setGlobeMode(true)
    get().setGlobeMode(false)
    expect(get().globeMode).toBe(false)
    expect(get().activeLayerId).toBe('hdi')
  })
})

// ── Overlay setters ───────────────────────────────────────────────────────────

describe('setTerminatorVisible', () => {
  it('enables the overlay and forces base layer', () => {
    get().setActiveLayerId('gdp')
    get().setTerminatorVisible(true)
    expect(get().terminatorVisible).toBe(true)
    expect(get().activeLayerId).toBe('base')
  })

  it('disabling does NOT auto-switch to base', () => {
    get().setActiveLayerId('hdi')
    get().setTerminatorVisible(false)
    expect(get().terminatorVisible).toBe(false)
    expect(get().activeLayerId).toBe('hdi')
  })
})

describe('setAuroraVisible', () => {
  it('enables the overlay and forces base layer', () => {
    get().setActiveLayerId('happiness')
    get().setAuroraVisible(true)
    expect(get().auroraVisible).toBe(true)
    expect(get().activeLayerId).toBe('base')
  })

  it('disabling does NOT auto-switch to base', () => {
    get().setActiveLayerId('mobile-desktop')
    get().setAuroraVisible(false)
    expect(get().auroraVisible).toBe(false)
    expect(get().activeLayerId).toBe('mobile-desktop')
  })
})

describe('setSubmarineCablesVisible', () => {
  it('toggles on and off without side-effects on other state', () => {
    get().setActiveLayerId('gdp')
    get().setSubmarineCablesVisible(true)
    expect(get().submarineCablesVisible).toBe(true)
    expect(get().activeLayerId).toBe('gdp') // not forced to base
    get().setSubmarineCablesVisible(false)
    expect(get().submarineCablesVisible).toBe(false)
  })
})

describe('setSatellitesVisible', () => {
  it('toggles on and off without side-effects on other state', () => {
    get().setGlobeMode(true)
    get().setSatellitesVisible(true)
    expect(get().satellitesVisible).toBe(true)
    expect(get().globeMode).toBe(true)
    get().setSatellitesVisible(false)
    expect(get().satellitesVisible).toBe(false)
  })
})

// ── setAuroraInfo ─────────────────────────────────────────────────────────────

describe('setAuroraInfo', () => {
  it('updates kp, label, and dataUnavailable together', () => {
    get().setAuroraInfo(7, 'Extreme', true)
    const s = get()
    expect(s.auroraKp).toBe(7)
    expect(s.auroraLabel).toBe('Extreme')
    expect(s.auroraDataUnavailable).toBe(true)
  })

  it('can reset to quiet state', () => {
    get().setAuroraInfo(7, 'Extreme', true)
    get().setAuroraInfo(1, 'Quiet', false)
    const s = get()
    expect(s.auroraKp).toBe(1)
    expect(s.auroraLabel).toBe('Quiet')
    expect(s.auroraDataUnavailable).toBe(false)
  })
})

// ── Misc setters ──────────────────────────────────────────────────────────────

describe('setTooltip', () => {
  it('updates the full tooltip state', () => {
    const tip: TooltipState = { visible: true, x: 100, y: 200, name: 'Germany', iso: 'DEU' }
    get().setTooltip(tip)
    expect(get().tooltip).toEqual(tip)
  })
})

describe('setSelectedCountry', () => {
  it('sets a country ISO', () => {
    get().setSelectedCountry('USA')
    expect(get().selectedCountry).toBe('USA')
  })

  it('can clear to null', () => {
    get().setSelectedCountry('USA')
    get().setSelectedCountry(null)
    expect(get().selectedCountry).toBeNull()
  })
})

describe('setLayerData', () => {
  it('stores a CountryDataMap', () => {
    get().setLayerData({ USA: 55000, DEU: 48000 })
    expect(get().layerData).toEqual({ USA: 55000, DEU: 48000 })
  })

  it('can be set to null', () => {
    get().setLayerData({ USA: 1 })
    get().setLayerData(null)
    expect(get().layerData).toBeNull()
  })
})
