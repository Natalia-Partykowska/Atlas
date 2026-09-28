import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import ConjunctionPanel from './ConjunctionPanel'
import { useAtlasStore } from '@/stores/useAtlasStore'
import { speakConjunction, stopSatelliteVoice } from '@/lib/satelliteVoice'
import type { ConjunctionEvent } from '@/lib/orbitStream'
import type { SatelliteCatalogEntry } from '@/lib/satelliteCatalog'

// The store reads the saved preference through this module too.
vi.mock('@/lib/satelliteVoice', () => ({
  speakConjunction: vi.fn(async () => {}),
  stopSatelliteVoice: vi.fn(),
  readVoiceEnabled: () => true,
  writeVoiceEnabled: vi.fn(),
}))

const STARLINK = 44713
const FENGYUN = 29228

const CATALOG = new Map<number, SatelliteCatalogEntry>([
  [STARLINK, { name: 'STARLINK-3087', group: 'active', intlDesignator: '19074A' }],
  [FENGYUN, { name: 'FENGYUN 1C DEB', group: 'debris', intlDesignator: '99025ABC' }],
])

function conjunction(overrides: Partial<ConjunctionEvent> = {}): ConjunctionEvent {
  return {
    noradA: STARLINK,
    noradB: FENGYUN,
    tcaEpochMs: Date.now() + 12 * 60_000,
    missKm: 0.42,
    relVelKms: 11.2,
    groupA: 'active',
    groupB: 'debris',
    midLat: 0,
    midLng: 0,
    midAltKm: 550,
    ...overrides,
  }
}

beforeEach(() => {
  vi.mocked(speakConjunction).mockClear()
  vi.mocked(stopSatelliteVoice).mockClear()
  useAtlasStore.setState({
    globeMode: true,
    conjunctionsVisible: true,
    conjunctionsReceivedFirstBatch: true,
    conjunctionEvents: [conjunction()],
    selectedConjunction: null,
    selectedSatellite: null,
    satelliteCatalog: CATALOG,
    satelliteVoiceEnabled: true,
  })
})

// The only row button — no other button has "↔" in its name.
const row = () => screen.getByRole('button', { name: /↔/ })
const replay = () => screen.queryByRole('button', { name: 'Read this conjunction aloud' })

// ── Row labels ────────────────────────────────────────────────────────────────

describe('ConjunctionPanel row labels', () => {
  it('names both satellites from the catalog, with their NORAD numbers underneath', () => {
    render(<ConjunctionPanel />)
    expect(screen.getByText('STARLINK-3087')).toBeInTheDocument()
    expect(screen.getByText('FENGYUN 1C DEB')).toBeInTheDocument()
    expect(screen.getByText(`#${STARLINK} ↔ #${FENGYUN}`)).toBeInTheDocument()
  })

  it('shows NORAD numbers until the catalog loads', () => {
    useAtlasStore.setState({ satelliteCatalog: null })
    render(<ConjunctionPanel />)
    expect(screen.getByText(`#${STARLINK}`)).toBeInTheDocument()
    expect(screen.getByText(`#${FENGYUN}`)).toBeInTheDocument()
    // No second line repeating the same numbers.
    expect(screen.queryByText(`#${STARLINK} ↔ #${FENGYUN}`)).not.toBeInTheDocument()
  })

  it('falls back to the NORAD number for a satellite the catalog does not know', () => {
    useAtlasStore.setState({
      satelliteCatalog: new Map([[STARLINK, CATALOG.get(STARLINK)!]]),
    })
    render(<ConjunctionPanel />)
    expect(screen.getByText('STARLINK-3087')).toBeInTheDocument()
    expect(screen.getByText(`#${FENGYUN}`)).toBeInTheDocument()
  })

  it('puts the full names and NORAD numbers in the row tooltip', () => {
    render(<ConjunctionPanel />)
    expect(row()).toHaveAttribute(
      'title',
      `STARLINK-3087 (#${STARLINK}) ↔ FENGYUN 1C DEB (#${FENGYUN})`,
    )
  })
})

// ── Selection ─────────────────────────────────────────────────────────────────

describe('ConjunctionPanel selection', () => {
  it('selects the pair on click and deselects it on a second click', () => {
    render(<ConjunctionPanel />)
    fireEvent.click(row())
    expect(useAtlasStore.getState().selectedConjunction).toEqual({
      noradA: STARLINK,
      noradB: FENGYUN,
    })
    fireEvent.click(row())
    expect(useAtlasStore.getState().selectedConjunction).toBeNull()
  })
})

// ── Voice ─────────────────────────────────────────────────────────────────────

describe('ConjunctionPanel voice', () => {
  it('reads the pair aloud from inside the click', () => {
    render(<ConjunctionPanel />)
    fireEvent.click(row())
    // Synchronous: the AudioContext has to start inside the user gesture.
    const [e] = useAtlasStore.getState().conjunctionEvents
    expect(speakConjunction).toHaveBeenCalledWith({
      nameA: 'STARLINK-3087',
      nameB: 'FENGYUN 1C DEB',
      tcaEpochMs: e.tcaEpochMs,
      missKm: 0.42,
    })
  })

  it('stays quiet when "Read aloud" is off', () => {
    useAtlasStore.setState({ satelliteVoiceEnabled: false })
    render(<ConjunctionPanel />)
    fireEvent.click(row())
    expect(useAtlasStore.getState().selectedConjunction).not.toBeNull()
    expect(speakConjunction).not.toHaveBeenCalled()
  })

  it('stays quiet until the catalog has named both satellites', () => {
    useAtlasStore.setState({ satelliteCatalog: new Map([[STARLINK, CATALOG.get(STARLINK)!]]) })
    render(<ConjunctionPanel />)
    fireEvent.click(row())
    expect(speakConjunction).not.toHaveBeenCalled()
    expect(replay()).not.toBeInTheDocument()
  })

  it('offers replay on the selected row only, even with "Read aloud" off', () => {
    useAtlasStore.setState({ satelliteVoiceEnabled: false })
    render(<ConjunctionPanel />)
    expect(replay()).not.toBeInTheDocument()
    fireEvent.click(row())
    fireEvent.click(replay()!)
    expect(speakConjunction).toHaveBeenCalledTimes(1)
  })

  it('stops the sentence when the row is deselected', () => {
    render(<ConjunctionPanel />)
    fireEvent.click(row())
    fireEvent.click(row())
    expect(stopSatelliteVoice).toHaveBeenCalledWith('conjunction')
  })

  it('stops the sentence when the drawer closes', () => {
    render(<ConjunctionPanel />)
    fireEvent.click(row())
    act(() => useAtlasStore.getState().setConjunctionsVisible(false))
    expect(stopSatelliteVoice).toHaveBeenCalledWith('conjunction')
  })

  it("doesn't cut off a satellite's name when picking it clears the selection", () => {
    render(<ConjunctionPanel />)
    fireEvent.click(row())
    act(() => useAtlasStore.getState().setSelectedSatellite({ norad: 25544 }))
    expect(useAtlasStore.getState().selectedConjunction).toBeNull()
    expect(stopSatelliteVoice).not.toHaveBeenCalled()
  })

  it('turns "Read aloud" off for both drawers and stops the voice', () => {
    render(<ConjunctionPanel />)
    const toggle = screen.getByRole('switch', { name: 'Read aloud' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(toggle)
    expect(useAtlasStore.getState().satelliteVoiceEnabled).toBe(false)
    expect(stopSatelliteVoice).toHaveBeenCalledWith()
  })
})
