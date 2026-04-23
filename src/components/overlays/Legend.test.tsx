import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import Legend from './Legend'
import { useAtlasStore } from '@/stores/useAtlasStore'

// Reset store to a known state before every test
beforeEach(() => {
  useAtlasStore.setState({
    activeLayerId: 'base',
    layerData: null,
  })
})

describe('Legend — null cases', () => {
  it('renders nothing when layerData is null (base layer default)', () => {
    const { container } = render(<Legend />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when activeLayerId is "base" even if layerData is set', () => {
    useAtlasStore.setState({ activeLayerId: 'base', layerData: { USA: 55000 } })
    const { container } = render(<Legend />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when layerData has no finite non-negative values', () => {
    useAtlasStore.setState({
      activeLayerId: 'gdp',
      layerData: { BAD: -1, NAN: NaN },
    })
    const { container } = render(<Legend />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when layerData is an empty object', () => {
    useAtlasStore.setState({ activeLayerId: 'gdp', layerData: {} })
    const { container } = render(<Legend />)
    expect(container.firstChild).toBeNull()
  })
})

describe('Legend — renders correctly', () => {
  beforeEach(() => {
    useAtlasStore.setState({
      activeLayerId: 'gdp',
      layerData: { USA: 60000, IND: 8000 },
    })
  })

  it('renders the layer label', () => {
    render(<Legend />)
    expect(screen.getByText('GDP per Capita')).toBeInTheDocument()
  })

  it('renders the layer description', () => {
    render(<Legend />)
    expect(screen.getByText(/Gross domestic product/i)).toBeInTheDocument()
  })

  it('renders a formatted minimum value', () => {
    render(<Legend />)
    // min = 8000 → format = '$8k'
    expect(screen.getByText('$8k')).toBeInTheDocument()
  })

  it('renders a formatted maximum value', () => {
    render(<Legend />)
    // max = 60000 → format = '$60k'
    expect(screen.getByText('$60k')).toBeInTheDocument()
  })

  it('gradient bar uses the layer colorLow and colorHigh', () => {
    render(<Legend />)
    const bar = document.querySelector('[style*="linear-gradient"]') as HTMLElement
    expect(bar).not.toBeNull()
    expect(bar.style.background).toContain('#0d2a4a') // GDP colorLow
    expect(bar.style.background).toContain('#06b6d4') // GDP colorHigh
  })
})

describe('Legend — other data layers', () => {
  it('renders HDI layer with its own label and formatted values', () => {
    useAtlasStore.setState({
      activeLayerId: 'hdi',
      layerData: { NOR: 0.966, NER: 0.394 },
    })
    render(<Legend />)
    expect(screen.getByText('Human Development')).toBeInTheDocument()
    expect(screen.getByText('0.394')).toBeInTheDocument()
    expect(screen.getByText('0.966')).toBeInTheDocument()
  })

  it('renders happiness layer with percentage-free numeric format', () => {
    useAtlasStore.setState({
      activeLayerId: 'happiness',
      layerData: { FIN: 7.74, AFG: 1.36 },
    })
    render(<Legend />)
    expect(screen.getByText('Happiness Score')).toBeInTheDocument()
    expect(screen.getByText('1.36')).toBeInTheDocument()
    expect(screen.getByText('7.74')).toBeInTheDocument()
  })

  it('renders mobile-desktop layer with % suffix', () => {
    useAtlasStore.setState({
      activeLayerId: 'mobile-desktop',
      layerData: { IND: 79, DEU: 52 },
    })
    render(<Legend />)
    expect(screen.getByText('52%')).toBeInTheDocument()
    expect(screen.getByText('79%')).toBeInTheDocument()
  })
})
