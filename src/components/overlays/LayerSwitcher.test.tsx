import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import LayerSwitcher from './LayerSwitcher'
import { useAtlasStore } from '@/stores/useAtlasStore'
import { LAYERS } from '@/data/layers.config'

beforeEach(() => {
  useAtlasStore.setState({
    activeLayerId: 'base',
    compareMode: false,
    measureMode: false,
    antipodeMode: false,
    terminatorVisible: false,
    auroraVisible: false,
  })
})

// ── Rendering ─────────────────────────────────────────────────────────────────

describe('LayerSwitcher rendering', () => {
  it('renders a button for every layer', () => {
    render(<LayerSwitcher />)
    for (const layer of LAYERS) {
      expect(screen.getByRole('button', { name: new RegExp(layer.label, 'i') })).toBeInTheDocument()
    }
  })

  it('active layer button has the active class styling', () => {
    useAtlasStore.setState({ activeLayerId: 'gdp' })
    render(<LayerSwitcher />)
    const gdpBtn = screen.getByRole('button', { name: /GDP per Capita/i })
    expect(gdpBtn.className).toContain('bg-white/10')
  })

  it('inactive layer buttons do not have the active class', () => {
    useAtlasStore.setState({ activeLayerId: 'base' })
    render(<LayerSwitcher />)
    const gdpBtn = screen.getByRole('button', { name: /GDP per Capita/i })
    expect(gdpBtn.className).not.toContain('bg-white/10')
  })
})

// ── Clicking a data layer ─────────────────────────────────────────────────────

describe('LayerSwitcher — clicking a data layer', () => {
  it('sets activeLayerId to the clicked layer', () => {
    render(<LayerSwitcher />)
    fireEvent.click(screen.getByRole('button', { name: /GDP per Capita/i }))
    expect(useAtlasStore.getState().activeLayerId).toBe('gdp')
  })

  it('turns off compareMode', () => {
    useAtlasStore.setState({ compareMode: true })
    render(<LayerSwitcher />)
    fireEvent.click(screen.getByRole('button', { name: /GDP per Capita/i }))
    expect(useAtlasStore.getState().compareMode).toBe(false)
  })

  it('turns off measureMode', () => {
    useAtlasStore.setState({ measureMode: true })
    render(<LayerSwitcher />)
    fireEvent.click(screen.getByRole('button', { name: /Human Development/i }))
    expect(useAtlasStore.getState().measureMode).toBe(false)
  })

  it('turns off antipodeMode', () => {
    useAtlasStore.setState({ antipodeMode: true })
    render(<LayerSwitcher />)
    fireEvent.click(screen.getByRole('button', { name: /Happiness/i }))
    expect(useAtlasStore.getState().antipodeMode).toBe(false)
  })

  it('hides the terminator overlay', () => {
    useAtlasStore.setState({ terminatorVisible: true })
    render(<LayerSwitcher />)
    fireEvent.click(screen.getByRole('button', { name: /GDP per Capita/i }))
    expect(useAtlasStore.getState().terminatorVisible).toBe(false)
  })

  it('hides the aurora overlay', () => {
    useAtlasStore.setState({ auroraVisible: true })
    render(<LayerSwitcher />)
    fireEvent.click(screen.getByRole('button', { name: /AI Adoption/i }))
    expect(useAtlasStore.getState().auroraVisible).toBe(false)
  })
})

// ── Clicking the base layer ───────────────────────────────────────────────────

describe('LayerSwitcher — clicking the base layer', () => {
  it('sets activeLayerId to "base"', () => {
    useAtlasStore.setState({ activeLayerId: 'gdp' })
    render(<LayerSwitcher />)
    fireEvent.click(screen.getByRole('button', { name: /Base Map/i }))
    expect(useAtlasStore.getState().activeLayerId).toBe('base')
  })

  it('turns off compareMode', () => {
    useAtlasStore.setState({ compareMode: true })
    render(<LayerSwitcher />)
    fireEvent.click(screen.getByRole('button', { name: /Base Map/i }))
    expect(useAtlasStore.getState().compareMode).toBe(false)
  })

  it('does NOT hide the terminator overlay when switching to base', () => {
    useAtlasStore.setState({ terminatorVisible: true })
    render(<LayerSwitcher />)
    fireEvent.click(screen.getByRole('button', { name: /Base Map/i }))
    // Base layer click skips the terminator/aurora calls
    expect(useAtlasStore.getState().terminatorVisible).toBe(true)
  })

  it('does NOT hide the aurora overlay when switching to base', () => {
    useAtlasStore.setState({ auroraVisible: true })
    render(<LayerSwitcher />)
    fireEvent.click(screen.getByRole('button', { name: /Base Map/i }))
    expect(useAtlasStore.getState().auroraVisible).toBe(true)
  })
})
