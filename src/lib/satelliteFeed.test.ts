import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSatelliteFeed } from './satelliteFeed'
import type { SatelliteFeedHooks } from './satelliteFeed'
import { DROP_GRACE_MS, FIRST_BATCH_DEADLINE_MS } from './orbitReconnect'
import type {
  ConjunctionEvent,
  OrbitStreamCallbacks,
  OrbitStreamHandle,
  ViewportBounds,
} from './orbitStream'
import type { SatPosition } from './satellites'

// ── Fakes ─────────────────────────────────────────────────────────────────────

const WORLD: ViewportBounds = { west: -180, south: -90, east: 180, north: 90 }

function positions(n: number): SatPosition[] {
  return Array.from({ length: n }, (_, i) => ({
    norad: 1000 + i,
    name: `SAT ${i}`,
    group: 'active',
    lng: 0,
    lat: 0,
    altitudeKm: 550,
  }))
}

const CONJ: ConjunctionEvent = {
  noradA: 1,
  noradB: 2,
  tcaEpochMs: 0,
  missKm: 1,
  relVelKms: 10,
  groupA: 'active',
  groupB: 'debris',
  midLat: 0,
  midLng: 0,
  midAltKm: 550,
}

/** One fake orbit-server socket, driven by the test. */
class FakeSocket {
  live = true
  closed = false
  viewports: ViewportBounds[] = []
  readonly url: string
  private readonly cbs: OrbitStreamCallbacks

  constructor(url: string, cbs: OrbitStreamCallbacks) {
    this.url = url
    this.cbs = cbs
  }

  readonly handle: OrbitStreamHandle = {
    updateViewport: (v) => this.viewports.push(v),
    isLive: () => this.live && !this.closed,
    close: () => {
      this.closed = true
    },
  }

  open() {
    this.cbs.onConnect?.()
  }
  batch(n = 3) {
    this.cbs.onPositions(positions(n))
  }
  conjunctions(events: ConjunctionEvent[] = [CONJ]) {
    this.cbs.onConjunctions?.(events)
  }
  fail() {
    this.live = false
    this.cbs.onDisconnect?.()
  }
}

/** Hooks that record every call, in order, as short strings. */
function recordingHooks() {
  const log: string[] = []
  const signals: AbortSignal[] = []
  const hooks: SatelliteFeedHooks = {
    paintLive: (p) => log.push(`paintLive:${p.length}`),
    startFallback: (signal) => {
      signals.push(signal)
      log.push('startFallback')
      signal.addEventListener('abort', () => log.push('stopFallback'))
    },
    clear: () => log.push('clear'),
    screeningLost: () => log.push('screeningLost'),
    conjunctions: (e) => log.push(`conjunctions:${e.length}`),
  }
  return { hooks, log, signals }
}

// `null` means no URL configured (a default parameter would swallow `undefined`).
function setup(url: string | null = 'wss://orbit.test/stream') {
  const sockets: FakeSocket[] = []
  const connect = vi.fn((u: string, cbs: OrbitStreamCallbacks) => {
    const s = new FakeSocket(u, cbs)
    sockets.push(s)
    return s.handle
  })
  const rec = recordingHooks()
  const feed = createSatelliteFeed({
    url: url ?? undefined,
    hooks: rec.hooks,
    viewport: () => WORLD,
    connect,
  })
  return { feed, connect, sockets, socket: () => sockets[sockets.length - 1], ...rec }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

// ── Start ─────────────────────────────────────────────────────────────────────

describe('createSatelliteFeed — start', () => {
  it('starts idle and does nothing until start()', () => {
    const { feed, connect, log } = setup()
    expect(feed.mode).toBe('idle')
    expect(connect).not.toHaveBeenCalled()
    expect(log).toEqual([])
  })

  it('goes straight to the bundled satellites when no URL is configured', () => {
    const { feed, connect, log } = setup(null)
    feed.start()
    expect(feed.mode).toBe('fallback')
    expect(connect).not.toHaveBeenCalled()
    expect(log).toEqual(['clear', 'screeningLost', 'startFallback'])
  })

  it('connects to the configured URL and waits for the first batch', () => {
    const { feed, connect, socket, log } = setup('wss://orbit.test/stream')
    feed.start()
    expect(connect).toHaveBeenCalledOnce()
    expect(socket().url).toBe('wss://orbit.test/stream')
    expect(feed.mode).toBe('connecting')
    expect(log).toEqual(['clear'])
  })

  it('sends the viewport when the socket opens', () => {
    const { feed, socket } = setup()
    feed.start()
    socket().open()
    expect(socket().viewports).toEqual([WORLD])
  })

  it('ignores a second start()', () => {
    const { feed, connect } = setup()
    feed.start()
    feed.start()
    expect(connect).toHaveBeenCalledOnce()
  })
})

// ── Live stream ───────────────────────────────────────────────────────────────

describe('createSatelliteFeed — live stream', () => {
  it('goes live on the first batch, flushing before the first paint', () => {
    const { feed, socket, log } = setup()
    feed.start()
    socket().batch(5)
    expect(feed.mode).toBe('ws')
    expect(log).toEqual(['clear', 'clear', 'paintLive:5'])
  })

  it('paints every later batch without flushing', () => {
    const { feed, socket, log } = setup()
    feed.start()
    socket().batch(5)
    socket().batch(6)
    socket().batch(7)
    expect(log.slice(2)).toEqual(['paintLive:5', 'paintLive:6', 'paintLive:7'])
  })

  it('passes conjunction batches on while connecting and live', () => {
    const { feed, socket, log } = setup()
    feed.start()
    socket().conjunctions()
    socket().batch()
    socket().conjunctions([CONJ, CONJ])
    expect(log.filter((l) => l.startsWith('conjunctions'))).toEqual([
      'conjunctions:1',
      'conjunctions:2',
    ])
  })

  it('forwards viewport changes only while live', () => {
    const { feed, socket } = setup()
    feed.start()
    feed.syncViewport()
    expect(socket().viewports).toEqual([])
    socket().batch()
    feed.syncViewport()
    expect(socket().viewports).toEqual([WORLD])
  })
})

// ── Losing the stream ─────────────────────────────────────────────────────────

describe('createSatelliteFeed — losing the stream', () => {
  it('keeps the last live frame for the grace period, then falls back', () => {
    const { feed, socket, log } = setup()
    feed.start()
    socket().batch()
    log.length = 0

    socket().fail()
    vi.advanceTimersByTime(DROP_GRACE_MS - 1)
    expect(feed.mode).toBe('ws')
    expect(log).toEqual([])

    vi.advanceTimersByTime(1)
    expect(feed.mode).toBe('fallback')
    expect(log).toEqual(['clear', 'screeningLost', 'startFallback'])
  })

  it('falls back after the grace period when the first connection fails', () => {
    const { feed, socket } = setup()
    feed.start()
    socket().fail()
    vi.advanceTimersByTime(DROP_GRACE_MS)
    expect(feed.mode).toBe('fallback')
  })

  it('falls back at the deadline when the socket has died without a close event', () => {
    const { feed, socket } = setup()
    feed.start()
    socket().live = false
    vi.advanceTimersByTime(FIRST_BATCH_DEADLINE_MS)
    expect(feed.mode).toBe('fallback')
  })

  it('drops conjunction and position batches once in fallback', () => {
    const { feed, socket, log } = setup()
    feed.start()
    socket().fail()
    vi.advanceTimersByTime(DROP_GRACE_MS)
    log.length = 0
    socket().conjunctions()
    socket().batch()
    expect(log).toEqual([])
  })

  // Known gaps, pinned so the change is visible: Stage 4 flips both.
  it('KNOWN GAP: never leaves fallback, even when a batch arrives', () => {
    const { feed, socket, connect } = setup()
    feed.start()
    socket().fail()
    vi.advanceTimersByTime(DROP_GRACE_MS)
    socket().batch()
    vi.advanceTimersByTime(10 * 60_000)
    expect(feed.mode).toBe('fallback')
    expect(connect).toHaveBeenCalledOnce()
  })

  it('KNOWN GAP: a socket that stays open without sending leaves the globe empty', () => {
    const { feed } = setup()
    feed.start()
    vi.advanceTimersByTime(10 * 60_000)
    expect(feed.mode).toBe('connecting')
  })
})

// ── Stop ──────────────────────────────────────────────────────────────────────

describe('createSatelliteFeed — stop', () => {
  it('closes the socket, clears the screen and leaves no timers', () => {
    const { feed, socket, log } = setup()
    feed.start()
    socket().batch()
    socket().fail()
    log.length = 0

    feed.stop()
    expect(feed.mode).toBe('idle')
    expect(socket().closed).toBe(true)
    expect(log).toEqual(['clear', 'screeningLost'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops the bundled loop before flushing the layer', () => {
    const { feed, log, signals } = setup(null)
    feed.start()
    log.length = 0
    feed.stop()
    expect(signals[0].aborted).toBe(true)
    expect(log).toEqual(['stopFallback', 'clear', 'screeningLost'])
  })

  it('ignores anything the socket sends after stop()', () => {
    const { feed, socket, log } = setup()
    feed.start()
    feed.stop()
    log.length = 0
    socket().batch()
    socket().conjunctions()
    socket().fail()
    vi.advanceTimersByTime(60_000)
    expect(log).toEqual([])
    expect(feed.mode).toBe('idle')
  })

  it('does nothing when it was never started', () => {
    const { feed, log } = setup()
    feed.stop()
    expect(log).toEqual([])
  })
})
