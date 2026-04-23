import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { createRef } from 'react'
import AntipodeLabel from './AntipodeLabel'
import type * as maplibregl from 'maplibre-gl'
import type { AntipodeInfo } from './AntipodeLabel'

// ── Mock MapLibre Map ─────────────────────────────────────────────────────────

function makeMockMap(projected = { x: 500, y: 250 }) {
  return {
    project: (_lngLat: unknown) => projected,
    on: () => {},
    off: () => {},
  }
}

const INFO: AntipodeInfo = {
  origin: [20.0, 48.0],       // Budapest-ish
  antipodePt: [-160.0, -48.0], // South Pacific
  label: 'South Pacific Ocean',
}

// ── Null / no-render cases ────────────────────────────────────────────────────

describe('AntipodeLabel — does not render', () => {
  it('renders nothing when info is null', () => {
    const mapRef = createRef<maplibregl.Map | null>()
    const { container } = render(<AntipodeLabel info={null} mapRef={mapRef} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when mapRef.current is null', () => {
    const mapRef = createRef<maplibregl.Map | null>()
    const { container } = render(<AntipodeLabel info={INFO} mapRef={mapRef} />)
    expect(container.firstChild).toBeNull()
  })
})

// ── Content ───────────────────────────────────────────────────────────────────

describe('AntipodeLabel — content', () => {
  function renderWithMap(info = INFO, projected = { x: 500, y: 250 }) {
    const mapRef = { current: makeMockMap(projected) } as React.RefObject<maplibregl.Map | null>
    return render(<AntipodeLabel info={info} mapRef={mapRef} />)
  }

  it('renders the "Antipode" section header', () => {
    renderWithMap()
    // Exact match avoids collision with the coordinate row "Antipode: -48.00°, ..."
    expect(screen.getByText('Antipode')).toBeInTheDocument()
  })

  it('renders the antipode label', () => {
    renderWithMap()
    expect(screen.getByText('South Pacific Ocean')).toBeInTheDocument()
  })

  it('renders origin coordinates with 2 decimal places', () => {
    renderWithMap()
    expect(screen.getByText(/Origin:.*48\.00°.*20\.00°/)).toBeInTheDocument()
  })

  it('renders antipode coordinates with 2 decimal places', () => {
    renderWithMap()
    expect(screen.getByText(/Antipode:.*-48\.00°.*-160\.00°/)).toBeInTheDocument()
  })

  it('renders the "Exact opposite side of Earth" footer', () => {
    renderWithMap()
    expect(screen.getByText(/Exact opposite side of Earth/i)).toBeInTheDocument()
  })

  it('positions the label at the projected screen coordinate', () => {
    renderWithMap(INFO, { x: 350, y: 180 })
    const el = document.querySelector('[style*="left"]') as HTMLElement
    expect(el.style.left).toBe('350px')
    expect(el.style.top).toBe('180px')
  })
})

// ── Coordinate formatting edge cases ─────────────────────────────────────────

describe('AntipodeLabel — coordinate formatting', () => {
  function renderWith(origin: [number, number], antipode: [number, number]) {
    const mapRef = { current: makeMockMap() } as React.RefObject<maplibregl.Map | null>
    const info: AntipodeInfo = { origin, antipodePt: antipode, label: 'Test' }
    render(<AntipodeLabel info={info} mapRef={mapRef} />)
  }

  it('formats positive lat/lng correctly', () => {
    renderWith([10.123, 55.678], [-169.877, -55.678])
    expect(screen.getByText(/Origin:.*55\.68°.*10\.12°/)).toBeInTheDocument()
  })

  it('formats zero coordinates without sign', () => {
    renderWith([0, 0], [180, 0])
    expect(screen.getByText(/Origin:.*0\.00°.*0\.00°/)).toBeInTheDocument()
  })

  it('handles negative origin longitude', () => {
    renderWith([-74.006, 40.712], [105.994, -40.712]) // NYC antipode
    expect(screen.getByText(/Origin:.*40\.71°.*-74\.01°/)).toBeInTheDocument()
  })
})
