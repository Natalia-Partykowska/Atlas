import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import ModeBanner from './ModeBanner'
import { useAtlasStore } from '@/stores/useAtlasStore'

beforeEach(() => {
  useAtlasStore.setState({
    measureMode: false,
    compareMode: false,
    antipodeMode: false,
  })
})

describe('ModeBanner', () => {
  it('renders no banner content when no mode is active', () => {
    render(<ModeBanner />)
    expect(screen.queryByText(/measure mode/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/compare mode/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/antipode mode/i)).not.toBeInTheDocument()
  })

  it('renders the measure banner when measureMode is on', () => {
    useAtlasStore.setState({ measureMode: true })
    render(<ModeBanner />)
    expect(screen.getByText(/measure mode/i)).toBeInTheDocument()
    expect(screen.getByText(/click two points to measure distance/i)).toBeInTheDocument()
    expect(screen.getByText(/esc to exit/i)).toBeInTheDocument()
  })

  it('renders the compare banner when compareMode is on', () => {
    useAtlasStore.setState({ compareMode: true })
    render(<ModeBanner />)
    expect(screen.getByText(/compare mode/i)).toBeInTheDocument()
    expect(screen.getByText(/click a country to pick it up/i)).toBeInTheDocument()
  })

  it('renders the antipode banner when antipodeMode is on', () => {
    useAtlasStore.setState({ antipodeMode: true })
    render(<ModeBanner />)
    expect(screen.getByText(/antipode mode/i)).toBeInTheDocument()
    expect(screen.getByText(/click anywhere to find its antipode/i)).toBeInTheDocument()
  })

  it('marks the banner aria-hidden when no mode is active', () => {
    const { container } = render(<ModeBanner />)
    const banner = container.querySelector('[aria-hidden="true"]')
    expect(banner).not.toBeNull()
  })

  it('marks the banner not aria-hidden when a mode is active', () => {
    useAtlasStore.setState({ measureMode: true })
    const { container } = render(<ModeBanner />)
    const banner = container.querySelector('[aria-hidden="false"]')
    expect(banner).not.toBeNull()
  })
})
