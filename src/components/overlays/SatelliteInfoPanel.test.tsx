import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import SatelliteInfoPanel from './SatelliteInfoPanel'
import { useAtlasStore } from '@/stores/useAtlasStore'
import { stopSatelliteVoice } from '@/lib/satelliteVoice'

// The store reads the saved preference through this module too.
vi.mock('@/lib/satelliteVoice', () => ({
  speakSatellite: vi.fn(async () => {}),
  stopSatelliteVoice: vi.fn(),
  readVoiceEnabled: () => true,
  writeVoiceEnabled: vi.fn(),
}))
// Opening the drawer requests the satellite's TLE; keep that off the network.
vi.mock('@/lib/satelliteTLE', () => ({
  fetchSatelliteTLE: vi.fn(() => new Promise(() => {})),
}))

beforeEach(() => {
  vi.mocked(stopSatelliteVoice).mockClear()
  useAtlasStore.setState({
    globeMode: true,
    satellitesVisible: true,
    selectedSatellite: null,
    satelliteCatalog: null,
    satelliteVoiceEnabled: true,
  })
})

describe('SatelliteInfoPanel voice', () => {
  it('cuts off a conjunction sentence when it opens and its own name when it closes', () => {
    render(<SatelliteInfoPanel />)
    act(() => useAtlasStore.getState().setSelectedSatellite({ norad: 25544 }))
    expect(stopSatelliteVoice).toHaveBeenLastCalledWith('conjunction')
    act(() => useAtlasStore.getState().setSelectedSatellite(null))
    expect(stopSatelliteVoice).toHaveBeenLastCalledWith('satellite')
  })

  it('shares the "Read aloud" switch with the Conjunctions drawer', () => {
    render(<SatelliteInfoPanel />)
    expect(screen.getByRole('switch', { name: 'Read aloud' })).toHaveAttribute('aria-checked', 'true')
  })
})
