import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ConjunctionPanel from './ConjunctionPanel'
import { useAtlasStore } from '@/stores/useAtlasStore'
import type { ConjunctionEvent } from '@/lib/orbitStream'
import type { SatelliteCatalogEntry } from '@/lib/satelliteCatalog'

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
  useAtlasStore.setState({
    globeMode: true,
    conjunctionsVisible: true,
    conjunctionsReceivedFirstBatch: true,
    conjunctionEvents: [conjunction()],
    selectedConjunction: null,
    selectedSatellite: null,
    satelliteCatalog: CATALOG,
  })
})

// The only row button — the header's close button has no "↔" in its name.
const row = () => screen.getByRole('button', { name: /↔/ })

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
