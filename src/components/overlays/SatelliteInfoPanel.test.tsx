import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import SatelliteInfoPanel from './SatelliteInfoPanel'
import { useAtlasStore } from '@/stores/useAtlasStore'
import { stopSatelliteVoice } from '@/lib/satelliteVoice'
import { fetchSatelliteTLE } from '@/lib/satelliteTLE'
import { findBundledTLE } from '@/lib/bundledSatellites'
import { SATELLITE_FEED_OFF } from '@/lib/satelliteFeed'
import type { SatelliteFeedStatus } from '@/lib/satelliteFeed'

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
// The bundled TLEs are the fallback when the server can't be reached.
vi.mock('@/lib/bundledSatellites', () => ({
  findBundledTLE: vi.fn(async () => null),
}))

const ISS_TLE = {
  name: 'ISS (ZARYA)',
  tle1: '1 25544U 98067A   26076.83874734  .00009567  00000+0  18567-3 0  9991',
  tle2: '2 25544  51.6336  32.0723 0006231 202.9067 157.1644 15.48349303557590',
}

const feed = (status: SatelliteFeedStatus) => ({ ...SATELLITE_FEED_OFF, status, canRetry: true })

beforeEach(() => {
  vi.mocked(stopSatelliteVoice).mockClear()
  vi.mocked(fetchSatelliteTLE).mockReset().mockImplementation(() => new Promise(() => {}))
  vi.mocked(findBundledTLE).mockReset().mockResolvedValue(null)
  useAtlasStore.setState({
    satelliteFeed: feed('live'),
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

describe('SatelliteInfoPanel orbit data without the server', () => {
  const open = (norad: number) =>
    act(() => useAtlasStore.getState().setSelectedSatellite({ norad }))

  it('uses the bundled TLE when the server fetch fails', async () => {
    useAtlasStore.setState({ satelliteFeed: feed('limited') })
    vi.mocked(fetchSatelliteTLE).mockRejectedValue(new TypeError('Failed to fetch'))
    vi.mocked(findBundledTLE).mockResolvedValue({ ...ISS_TLE, group: 'iss' })
    render(<SatelliteInfoPanel />)
    open(25544)

    expect(await screen.findByText('51.63°')).toBeInTheDocument()
    // The catalog isn't loaded, but the bundled file knows the group.
    expect(screen.getByText('iss')).toBeInTheDocument()
    expect(screen.queryByText(/unknown group/i)).not.toBeInTheDocument()
    expect(screen.getByText('Period')).toBeInTheDocument()
    expect(findBundledTLE).toHaveBeenCalledWith(25544)
    expect(screen.queryByText(/failed to fetch/i)).not.toBeInTheDocument()
  })

  it('says the orbit needs the live feed for a satellite that is not bundled', async () => {
    useAtlasStore.setState({ satelliteFeed: feed('limited') })
    vi.mocked(fetchSatelliteTLE).mockRejectedValue(new TypeError('Failed to fetch'))
    render(<SatelliteInfoPanel />)
    open(44713)

    const note = await screen.findByText('Orbit data needs the live feed.')
    expect(note).not.toHaveClass('text-red-300/80')
    expect(screen.queryByText(/failed to fetch/i)).not.toBeInTheDocument()
  })

  it('still shows a real error while the feed is live', async () => {
    vi.mocked(fetchSatelliteTLE).mockRejectedValue(new Error('TLE not found for NORAD 44713'))
    render(<SatelliteInfoPanel />)
    open(44713)

    expect(await screen.findByText('TLE not found for NORAD 44713')).toBeInTheDocument()
    expect(screen.queryByText('Orbit data needs the live feed.')).not.toBeInTheDocument()
  })

  it('fetches the server TLE again when the live feed comes back', async () => {
    useAtlasStore.setState({ satelliteFeed: feed('limited') })
    vi.mocked(fetchSatelliteTLE).mockRejectedValue(new TypeError('Failed to fetch'))
    vi.mocked(findBundledTLE).mockResolvedValue(ISS_TLE)
    render(<SatelliteInfoPanel />)
    open(25544)
    await screen.findByText('51.63°')
    expect(fetchSatelliteTLE).toHaveBeenCalledTimes(1)

    vi.mocked(fetchSatelliteTLE).mockResolvedValue(ISS_TLE)
    act(() => useAtlasStore.setState({ satelliteFeed: feed('live') }))
    await vi.waitFor(() => expect(fetchSatelliteTLE).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('51.63°')).toBeInTheDocument()
  })

  it('keeps a server TLE when the feed drops', async () => {
    vi.mocked(fetchSatelliteTLE).mockResolvedValue(ISS_TLE)
    render(<SatelliteInfoPanel />)
    open(25544)
    await screen.findByText('51.63°')

    act(() => useAtlasStore.setState({ satelliteFeed: feed('limited') }))
    act(() => useAtlasStore.setState({ satelliteFeed: feed('live') }))
    expect(fetchSatelliteTLE).toHaveBeenCalledTimes(1)
    expect(screen.getByText('51.63°')).toBeInTheDocument()
  })
})
