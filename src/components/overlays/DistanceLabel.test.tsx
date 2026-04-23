import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { createRef } from 'react'
import DistanceLabel from './DistanceLabel'
import type * as maplibregl from 'maplibre-gl'

// ── Mock MapLibre Map ─────────────────────────────────────────────────────────

function makeMockMap(projected: { x: number; y: number }, containerSize = { w: 800, h: 600 }) {
  const handlers: Record<string, (() => void)[]> = {}
  return {
    project: (_lngLat: unknown) => projected,
    getContainer: () => ({ clientWidth: containerSize.w, clientHeight: containerSize.h }),
    on: (event: string, cb: () => void) => {
      handlers[event] = handlers[event] ?? []
      handlers[event].push(cb)
    },
    off: (event: string, cb: () => void) => {
      handlers[event] = (handlers[event] ?? []).filter((h) => h !== cb)
    },
    // Fire a registered event — lets tests simulate map move/zoom
    _fire: (event: string) => { for (const h of handlers[event] ?? []) h() },
  }
}

const MEASURE_INFO = {
  distanceKm: 1000,
  rhumbKm: 1050,
  midpoint: [30, 45] as [number, number],
}

// ── Null / no-render cases ────────────────────────────────────────────────────

describe('DistanceLabel — does not render', () => {
  it('renders nothing when info is null', () => {
    const mapRef = createRef<maplibregl.Map | null>()
    const { container } = render(<DistanceLabel info={null} mapRef={mapRef} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when mapRef.current is null', () => {
    const mapRef = createRef<maplibregl.Map | null>()
    const { container } = render(<DistanceLabel info={MEASURE_INFO} mapRef={mapRef} />)
    expect(container.firstChild).toBeNull()
  })
})

// ── Content ───────────────────────────────────────────────────────────────────

describe('DistanceLabel — content', () => {
  let mapRef: React.RefObject<maplibregl.Map | null>

  beforeEach(() => {
    mapRef = { current: makeMockMap({ x: 400, y: 300 }) } as React.RefObject<maplibregl.Map | null>
  })

  it('renders the great-circle distance in km', () => {
    render(<DistanceLabel info={MEASURE_INFO} mapRef={mapRef} />)
    expect(screen.getByText('1000 km')).toBeInTheDocument()
  })

  it('renders the rhumb (Mercator) distance in km', () => {
    render(<DistanceLabel info={MEASURE_INFO} mapRef={mapRef} />)
    expect(screen.getByText('1050 km')).toBeInTheDocument()
  })

  it('renders the equivalent distance in miles', () => {
    render(<DistanceLabel info={MEASURE_INFO} mapRef={mapRef} />)
    // 1000 km × 0.621371 ≈ 621 mi
    expect(screen.getByText('621 mi')).toBeInTheDocument()
  })

  it('shows positive distortion when rhumb > great-circle', () => {
    render(<DistanceLabel info={MEASURE_INFO} mapRef={mapRef} />)
    // rhumb=1050, gc=1000 → +5.0%
    expect(screen.getByText('+5.0%')).toBeInTheDocument()
  })

  it('shows negative distortion when rhumb < great-circle', () => {
    const info = { distanceKm: 1000, rhumbKm: 950, midpoint: [0, 0] as [number, number] }
    render(<DistanceLabel info={info} mapRef={mapRef} />)
    // -5.0%
    expect(screen.getByText('-5.0%')).toBeInTheDocument()
  })

  it('renders the Great circle and Mercator line labels', () => {
    render(<DistanceLabel info={MEASURE_INFO} mapRef={mapRef} />)
    expect(screen.getByText('Great circle')).toBeInTheDocument()
    expect(screen.getByText('Mercator line')).toBeInTheDocument()
  })
})

// ── Clamping ──────────────────────────────────────────────────────────────────

describe('DistanceLabel — clamping', () => {
  it('clamps x to minimum 96px when projected point is near left edge', () => {
    const mapRef = {
      current: makeMockMap({ x: 10, y: 300 }, { w: 800, h: 600 }),
    } as React.RefObject<maplibregl.Map | null>

    render(<DistanceLabel info={MEASURE_INFO} mapRef={mapRef} />)
    const el = document.querySelector('[style*="left"]') as HTMLElement
    expect(el.style.left).toBe('96px')
  })

  it('clamps x to W-96 when projected point is near right edge', () => {
    const mapRef = {
      current: makeMockMap({ x: 790, y: 300 }, { w: 800, h: 600 }),
    } as React.RefObject<maplibregl.Map | null>

    render(<DistanceLabel info={MEASURE_INFO} mapRef={mapRef} />)
    const el = document.querySelector('[style*="left"]') as HTMLElement
    expect(el.style.left).toBe('704px') // 800 - 96
  })

  it('clamps y to minimum 112px when projected point is near the top', () => {
    const mapRef = {
      current: makeMockMap({ x: 400, y: 5 }, { w: 800, h: 600 }),
    } as React.RefObject<maplibregl.Map | null>

    render(<DistanceLabel info={MEASURE_INFO} mapRef={mapRef} />)
    const el = document.querySelector('[style*="top"]') as HTMLElement
    expect(el.style.top).toBe('112px')
  })

  it('clamps y to H-12 when projected point is near the bottom', () => {
    const mapRef = {
      current: makeMockMap({ x: 400, y: 595 }, { w: 800, h: 600 }),
    } as React.RefObject<maplibregl.Map | null>

    render(<DistanceLabel info={MEASURE_INFO} mapRef={mapRef} />)
    const el = document.querySelector('[style*="top"]') as HTMLElement
    expect(el.style.top).toBe('588px') // 600 - 12
  })

  it('passes through an unclamped position unchanged', () => {
    const mapRef = {
      current: makeMockMap({ x: 400, y: 300 }, { w: 800, h: 600 }),
    } as React.RefObject<maplibregl.Map | null>

    render(<DistanceLabel info={MEASURE_INFO} mapRef={mapRef} />)
    const el = document.querySelector('[style*="left"]') as HTMLElement
    expect(el.style.left).toBe('400px')
    expect(el.style.top).toBe('300px')
  })
})

// ── Map event subscription ────────────────────────────────────────────────────

describe('DistanceLabel — map event subscription', () => {
  it('re-projects when the map fires a move event', async () => {
    let projectedX = 400
    const mockMap = {
      ...makeMockMap({ x: 400, y: 300 }),
      project: () => ({ x: projectedX, y: 300 }),
      getContainer: () => ({ clientWidth: 800, clientHeight: 600 }),
    }
    // Attach the handlers to the real instance
    const handlers: Record<string, (() => void)[]> = {}
    mockMap.on = (event: string, cb: () => void) => {
      handlers[event] = handlers[event] ?? []
      handlers[event].push(cb)
    }
    mockMap.off = () => {}
    mockMap._fire = (event: string) => { for (const h of handlers[event] ?? []) h() }

    const mapRef = { current: mockMap } as unknown as React.RefObject<maplibregl.Map | null>
    render(<DistanceLabel info={MEASURE_INFO} mapRef={mapRef} />)

    // Move the map — project now returns x=200
    projectedX = 200
    await act(async () => { mockMap._fire('move') })

    const el = document.querySelector('[style*="left"]') as HTMLElement
    expect(el.style.left).toBe('200px')
  })
})
