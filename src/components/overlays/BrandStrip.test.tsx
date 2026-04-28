import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import BrandStrip from './BrandStrip'
import { useAtlasStore } from '@/stores/useAtlasStore'

beforeEach(() => {
  useAtlasStore.setState({
    satellitesVisible: false,
    satelliteCount: 0,
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

  it('renders the satellite count when satellites are visible AND count > 0', () => {
    useAtlasStore.setState({ satellitesVisible: true, satelliteCount: 17243 })
    render(<BrandStrip />)
    expect(screen.getByText(/live · 17,243 sats/i)).toBeInTheDocument()
  })

  it('hides satellite count when count is 0 even if satellites are visible', () => {
    useAtlasStore.setState({ satellitesVisible: true, satelliteCount: 0 })
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
      auroraVisible: true,
      auroraKp: 4.2,
    })
    render(<BrandStrip />)
    expect(screen.getByText(/live · 5,000 sats · kp 4\.2/i)).toBeInTheDocument()
  })
})
