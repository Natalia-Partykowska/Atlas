import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import BrandStrip from './BrandStrip'
import { useAtlasStore } from '@/stores/useAtlasStore'
import { SATELLITE_FEED_OFF } from '@/lib/satelliteFeed'
import type { SatelliteFeedStatus } from '@/lib/satelliteFeed'

const feed = (status: SatelliteFeedStatus) => ({ ...SATELLITE_FEED_OFF, status, canRetry: true })

beforeEach(() => {
  useAtlasStore.setState({
    satellitesVisible: false,
    satelliteCount: 0,
    satelliteFeed: SATELLITE_FEED_OFF,
    auroraVisible: false,
    auroraKp: 2,
    auroraDataUnavailable: false,
  })
})

describe('BrandStrip — brand', () => {
  it('always renders the Atlas wordmark', () => {
    render(<BrandStrip />)
    expect(screen.getByText(/atlas/i)).toBeInTheDocument()
  })
})

describe('BrandStrip — status line', () => {
  it('hides the status line when nothing live is flowing', () => {
    render(<BrandStrip />)
    expect(screen.queryByText(/live/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/kp/i)).not.toBeInTheDocument()
  })

  it('renders the satellite count when the live feed is on screen', () => {
    useAtlasStore.setState({ satellitesVisible: true, satelliteCount: 17243, satelliteFeed: feed('live') })
    render(<BrandStrip />)
    expect(screen.getByText(/live · 17,243 sats/i)).toBeInTheDocument()
  })

  it('hides satellite count when count is 0 even if satellites are visible', () => {
    useAtlasStore.setState({ satellitesVisible: true, satelliteCount: 0, satelliteFeed: feed('live') })
    render(<BrandStrip />)
    expect(screen.queryByText(/live/i)).not.toBeInTheDocument()
  })

  it('renders Kp when aurora is enabled with available data', () => {
    useAtlasStore.setState({ auroraVisible: true, auroraKp: 3.7 })
    render(<BrandStrip />)
    expect(screen.getByText(/kp 3\.7/i)).toBeInTheDocument()
  })

  it('hides Kp when aurora is enabled but data is unavailable', () => {
    useAtlasStore.setState({
      auroraVisible: true,
      auroraKp: 2,
      auroraDataUnavailable: true,
    })
    render(<BrandStrip />)
    expect(screen.queryByText(/kp/i)).not.toBeInTheDocument()
  })

  it('combines satellite count + Kp when both are live', () => {
    useAtlasStore.setState({
      satellitesVisible: true,
      satelliteCount: 5000,
      satelliteFeed: feed('live'),
      auroraVisible: true,
      auroraKp: 4.2,
    })
    render(<BrandStrip />)
    expect(screen.getByTestId('brand-status')).toHaveTextContent(/live · 5,000 sats · kp 4\.2/i)
  })
})

describe('BrandStrip — satellite feed', () => {
  const line = () => screen.getByTestId('brand-status')

  it('says Connecting… before the first batch', () => {
    useAtlasStore.setState({ satellitesVisible: true, satelliteFeed: feed('connecting') })
    render(<BrandStrip />)
    expect(screen.getByText('Connecting…')).toBeInTheDocument()
    expect(screen.queryByText(/live/i)).not.toBeInTheDocument()
  })

  it('never calls the bundled satellites "Live"', () => {
    useAtlasStore.setState({ satellitesVisible: true, satelliteCount: 238, satelliteFeed: feed('limited') })
    render(<BrandStrip />)
    expect(screen.getByText(/limited · 238 sats/i)).toBeInTheDocument()
    expect(screen.queryByText(/live/i)).not.toBeInTheDocument()
    expect(line()).toHaveAttribute('data-feed', 'degraded')
  })

  it('says Limited while the bundled satellites are still loading', () => {
    useAtlasStore.setState({ satellitesVisible: true, satelliteCount: 0, satelliteFeed: feed('limited') })
    render(<BrandStrip />)
    expect(screen.getByText('Limited')).toBeInTheDocument()
  })

  it('says Reconnecting while a dropped stream holds its last frame', () => {
    useAtlasStore.setState({ satellitesVisible: true, satelliteCount: 18049, satelliteFeed: feed('reconnecting') })
    render(<BrandStrip />)
    expect(screen.getByText(/reconnecting · 18,049 sats/i)).toBeInTheDocument()
    expect(line()).toHaveAttribute('data-feed', 'degraded')
  })

  it('marks the live feed as live', () => {
    useAtlasStore.setState({ satellitesVisible: true, satelliteCount: 18049, satelliteFeed: feed('live') })
    render(<BrandStrip />)
    expect(line()).toHaveAttribute('data-feed', 'live')
  })

  it('keeps Kp next to a limited feed', () => {
    useAtlasStore.setState({
      satellitesVisible: true,
      satelliteCount: 238,
      satelliteFeed: feed('limited'),
      auroraVisible: true,
      auroraKp: 3.1,
    })
    render(<BrandStrip />)
    expect(screen.getByText(/limited · 238 sats/i)).toBeInTheDocument()
    expect(screen.getByText(/kp 3\.1/i)).toBeInTheDocument()
  })
})
