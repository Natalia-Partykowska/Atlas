import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import SatelliteFeedNotice from './SatelliteFeedNotice'
import { useAtlasStore } from '@/stores/useAtlasStore'
import { SATELLITE_FEED_OFF } from '@/lib/satelliteFeed'
import type { SatelliteFeedState } from '@/lib/satelliteFeed'

const T0 = 1_790_000_000_000

const LIMITED: SatelliteFeedState = {
  ...SATELLITE_FEED_OFF,
  status: 'limited',
  canRetry: true,
  nextRetryAt: T0 + 4_000,
  lastLiveCount: 18_049,
}

const setFeed = (patch: Partial<SatelliteFeedState>) =>
  act(() => useAtlasStore.setState((s) => ({ satelliteFeed: { ...s.satelliteFeed, ...patch } })))

const notice = () => screen.getByRole('status')
const retryButton = () => screen.queryByRole('button', { name: 'Retry now' })

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  useAtlasStore.setState({
    globeMode: true,
    satellitesVisible: true,
    satelliteCount: 238,
    satelliteFeed: LIMITED,
    satelliteRetryRequest: 0,
    measureMode: false,
    antipodeMode: false,
    compareMode: false,
    selectedSatellite: null,
    conjunctionsVisible: false,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('SatelliteFeedNotice — when it shows', () => {
  it('shows while the globe is on the bundled satellites', () => {
    render(<SatelliteFeedNotice />)
    expect(notice()).toHaveTextContent('Live satellite feed unavailable')
    expect(notice()).toHaveTextContent('Showing 238 bundled satellites instead of 18,049')
  })

  it.each(['off', 'connecting', 'live', 'reconnecting'] as const)(
    'stays empty while the feed is %s',
    (status) => {
      useAtlasStore.setState({ satelliteFeed: { ...LIMITED, status } })
      render(<SatelliteFeedNotice />)
      expect(notice()).toBeEmptyDOMElement()
    },
  )

  it('stays empty when satellites are off or the map is flat', () => {
    useAtlasStore.setState({ satellitesVisible: false })
    const { unmount } = render(<SatelliteFeedNotice />)
    expect(notice()).toBeEmptyDOMElement()
    unmount()
    useAtlasStore.setState({ satellitesVisible: true, globeMode: false })
    render(<SatelliteFeedNotice />)
    expect(notice()).toBeEmptyDOMElement()
  })

  it('leaves out the live count when the feed was never live this visit', () => {
    useAtlasStore.setState({ satelliteFeed: { ...LIMITED, lastLiveCount: null } })
    render(<SatelliteFeedNotice />)
    expect(notice()).toHaveTextContent('Showing 238 bundled satellites')
    expect(notice()).not.toHaveTextContent('instead of')
  })

  it('does not count satellites that are still loading', () => {
    useAtlasStore.setState({ satelliteCount: 0 })
    render(<SatelliteFeedNotice />)
    expect(notice()).toHaveTextContent('Showing the bundled satellites')
  })

  it('is a polite live region, so screen readers hear it without being interrupted', () => {
    render(<SatelliteFeedNotice />)
    expect(notice()).toHaveAttribute('aria-live', 'polite')
  })
})

describe('SatelliteFeedNotice — retrying', () => {
  it('counts down to the next attempt', () => {
    render(<SatelliteFeedNotice />)
    expect(notice()).toHaveTextContent('Retrying in 4 s')
    act(() => vi.advanceTimersByTime(1_000))
    expect(notice()).toHaveTextContent('Retrying in 3 s')
  })

  it('keeps the ticking seconds away from screen readers', () => {
    render(<SatelliteFeedNotice />)
    const countdown = screen.getByText('Retrying in 4 s')
    expect(countdown).toHaveAttribute('aria-hidden', 'true')
    expect(notice()).toHaveTextContent('Retrying automatically')
  })

  it('says Reconnecting… and disables the button while an attempt runs', () => {
    useAtlasStore.setState({ satelliteFeed: { ...LIMITED, attempting: true, nextRetryAt: null } })
    render(<SatelliteFeedNotice />)
    expect(notice()).toHaveTextContent('Reconnecting…')
    expect(retryButton()).toBeDisabled()
  })

  it('waits for the network while offline', () => {
    useAtlasStore.setState({ satelliteFeed: { ...LIMITED, offline: true, nextRetryAt: null } })
    render(<SatelliteFeedNotice />)
    expect(notice()).toHaveTextContent('Waiting for network')
    expect(retryButton()).toBeDisabled()
  })

  it('asks the feed to retry when Retry now is clicked', () => {
    render(<SatelliteFeedNotice />)
    fireEvent.click(retryButton()!)
    expect(useAtlasStore.getState().satelliteRetryRequest).toBe(1)
  })

  it('offers no retry when no orbit server is configured', () => {
    useAtlasStore.setState({
      satelliteFeed: { ...LIMITED, canRetry: false, nextRetryAt: null, lastLiveCount: null },
    })
    render(<SatelliteFeedNotice />)
    expect(notice()).toHaveTextContent('Live orbit server not configured')
    expect(notice()).not.toHaveTextContent('Retrying')
    expect(retryButton()).not.toBeInTheDocument()
  })
})

describe('SatelliteFeedNotice — dismiss and recovery', () => {
  it('can be hidden for the rest of this outage', () => {
    render(<SatelliteFeedNotice />)
    fireEvent.click(screen.getByRole('button', { name: 'Hide notice' }))
    expect(notice()).toBeEmptyDOMElement()
    setFeed({ attempting: true, nextRetryAt: null })
    expect(notice()).toBeEmptyDOMElement()
  })

  it('comes back for the next outage after being hidden', () => {
    render(<SatelliteFeedNotice />)
    fireEvent.click(screen.getByRole('button', { name: 'Hide notice' }))
    setFeed({ status: 'live' })
    act(() => vi.advanceTimersByTime(5_000))
    setFeed({ status: 'reconnecting' })
    setFeed({ status: 'limited' })
    expect(notice()).toHaveTextContent('Live satellite feed unavailable')
  })

  it('says the live feed is back for 3 s', () => {
    render(<SatelliteFeedNotice />)
    act(() => useAtlasStore.setState({ satelliteCount: 18_049 }))
    setFeed({ status: 'live', attempting: false, nextRetryAt: null })
    expect(notice()).toHaveTextContent('Live feed restored · 18,049 satellites')
    act(() => vi.advanceTimersByTime(2_999))
    expect(notice()).not.toBeEmptyDOMElement()
    act(() => vi.advanceTimersByTime(1))
    expect(notice()).toBeEmptyDOMElement()
  })

  it('says nothing when a brief drop recovers within the grace', () => {
    useAtlasStore.setState({ satelliteFeed: { ...LIMITED, status: 'reconnecting' } })
    render(<SatelliteFeedNotice />)
    setFeed({ status: 'live' })
    expect(notice()).toBeEmptyDOMElement()
  })
})

describe('SatelliteFeedNotice — placement', () => {
  it('sits at the top when no mode banner is showing', () => {
    render(<SatelliteFeedNotice />)
    expect(notice()).toHaveClass('top-4')
  })

  it('moves below the mode banner while Measure or Antipode is on', () => {
    useAtlasStore.setState({ measureMode: true })
    render(<SatelliteFeedNotice />)
    expect(notice()).toHaveClass('top-14')
  })

  // A drawer covers the right 380 px; centred on the window, the pill's
  // "Retry now" would slide under it on a 1280 px screen.
  it.each([
    ['satellite', { selectedSatellite: { norad: 25544 } }],
    ['conjunctions', { conjunctionsVisible: true }],
  ])('centres in the map area left of an open %s drawer', (_name, state) => {
    render(<SatelliteFeedNotice />)
    expect(notice()).toHaveClass('left-1/2')
    act(() => useAtlasStore.setState(state))
    expect(notice()).toHaveClass('left-[calc((100vw-380px)/2)]')
    expect(notice()).not.toHaveClass('left-1/2')
  })
})
