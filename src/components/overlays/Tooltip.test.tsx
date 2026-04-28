import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import Tooltip from './Tooltip'
import { useAtlasStore } from '@/stores/useAtlasStore'

beforeEach(() => {
  useAtlasStore.setState({
    tooltip: { visible: false, x: 0, y: 0, name: '', iso: '' },
    satelliteHover: { visible: false, x: 0, y: 0, norad: 0, name: '' },
    activeLayerId: 'base',
    layerData: null,
  })
})

describe('Tooltip — visibility', () => {
  it('renders nothing when neither tooltip nor satellite hover is visible', () => {
    const { container } = render(<Tooltip />)
    expect(container.firstChild).toBeNull()
  })
})

describe('Tooltip — country tooltip', () => {
  it('renders the country name when visible', () => {
    useAtlasStore.setState({
      tooltip: { visible: true, x: 100, y: 100, name: 'United States', iso: 'USA' },
    })
    render(<Tooltip />)
    expect(screen.getByText('United States')).toBeInTheDocument()
  })

  it('renders the formatted value when on a data layer', () => {
    useAtlasStore.setState({
      tooltip: { visible: true, x: 100, y: 100, name: 'United States', iso: 'USA' },
      activeLayerId: 'gdp',
      layerData: { USA: 60000, IND: 8000, NOR: 90000 },
    })
    render(<Tooltip />)
    expect(screen.getByText(/\$60k/)).toBeInTheDocument()
  })

  it('renders the rank inline with the formatted value', () => {
    useAtlasStore.setState({
      tooltip: { visible: true, x: 100, y: 100, name: 'United States', iso: 'USA' },
      activeLayerId: 'gdp',
      layerData: { USA: 60000, IND: 8000, NOR: 90000 },
    })
    render(<Tooltip />)
    // USA value 60000 is 2nd of 3 (NOR is 1st, IND is 3rd)
    expect(screen.getByText(/2nd of 3/)).toBeInTheDocument()
  })

  it('omits the value and rank on the base layer', () => {
    useAtlasStore.setState({
      tooltip: { visible: true, x: 100, y: 100, name: 'United States', iso: 'USA' },
      activeLayerId: 'base',
      layerData: null,
    })
    render(<Tooltip />)
    expect(screen.getByText('United States')).toBeInTheDocument()
    expect(screen.queryByText(/of \d+/)).not.toBeInTheDocument()
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument()
  })

  it('shows value but no rank when iso is not in the dataset', () => {
    useAtlasStore.setState({
      tooltip: { visible: true, x: 100, y: 100, name: 'Greenland', iso: 'GRL' },
      activeLayerId: 'gdp',
      layerData: { USA: 60000, IND: 8000, NOR: 90000 }, // GRL absent
    })
    render(<Tooltip />)
    // No formatted value either since layerData[GRL] is undefined
    expect(screen.queryByText(/of \d+/)).not.toBeInTheDocument()
  })
})

describe('Tooltip — satellite hover', () => {
  it('renders the satellite name when visible', () => {
    useAtlasStore.setState({
      satelliteHover: { visible: true, x: 100, y: 100, norad: 25544, name: 'ISS (ZARYA)' },
    })
    render(<Tooltip />)
    expect(screen.getByText('ISS (ZARYA)')).toBeInTheDocument()
  })
})
