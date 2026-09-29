import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSatelliteFeed } from './satelliteFeed'
import type { SatelliteFeedBrowser, SatelliteFeedHooks, SatelliteFeedState } from './satelliteFeed'
import {
  DROP_GRACE_MS,
  FIRST_BATCH_DEADLINE_MS,
  GRACE_RETRY_MS,
  RETRY_MAX_MS,
} from './orbitReconnect'
import type {
  ConjunctionEvent,
  OrbitStreamCallbacks,
  OrbitStreamHandle,
  ViewportBounds,
} from './orbitStream'
import type { SatPosition } from './satellites'

// ── Fakes ─────────────────────────────────────────────────────────────────────

const WORLD: ViewportBounds = { west: -180, south: -90, east: 180, north: 90 }
const T0 = 1_790_000_000_000

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
  closed = false
  viewports: ViewportBounds[] = []
  readonly openedAt = Date.now()
  readonly url: string
  private readonly cbs: OrbitStreamCallbacks

  constructor(url: string, cbs: OrbitStreamCallbacks) {
    this.url = url
    this.cbs = cbs
  }

  readonly handle: OrbitStreamHandle = {
    updateViewport: (v) => this.viewports.push(v),
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
    this.cbs.onDisconnect?.()
  }
}

/** The tab and the network, driven by the test. */
function fakeBrowser() {
  const listeners = new Set<() => void>()
  const env = { hidden: false, offline: false }
  const browser: SatelliteFeedBrowser = {
    isHidden: () => env.hidden,
    isOffline: () => env.offline,
    subscribe: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
  /** Changes the tab/network state and fires the change event. */
  const change = (next: Partial<typeof env>) => {
    Object.assign(env, next)
    for (const cb of [...listeners]) cb()
  }
  return { browser, change, listeners }
}

/** Hooks that record every drawing call, in order, as short strings. */
function recordingHooks() {
  const log: string[] = []
  const signals: AbortSignal[] = []
  const statuses: SatelliteFeedState[] = []
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
    status: (s) => statuses.push(s),
  }
  return { hooks, log, signals, statuses }
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
  const env = fakeBrowser()
  const feed = createSatelliteFeed({
    url: url ?? undefined,
    hooks: rec.hooks,
    viewport: () => WORLD,
    connect,
    browser: env.browser,
    // The middle of [0, 1): no jitter, so delays are exactly 1, 2, 4 … s.
    random: () => 0.5,
  })
  const socket = () => sockets[sockets.length - 1]
  const status = () => rec.statuses[rec.statuses.length - 1]
  /** Sockets the feed hasn't closed. There must never be more than one. */
  const openSockets = () => sockets.filter((s) => !s.closed).length
  /** Seconds after T0 at which each socket was opened. */
  const openTimes = () => sockets.map((s) => (s.openedAt - T0) / 1000)
  return { feed, connect, sockets, socket, status, openSockets, openTimes, ...rec, ...env }
}

/** Starts the feed and fails the first connection: it's in fallback now. */
function startDown(f: ReturnType<typeof setup>) {
  f.feed.start()
  f.socket().fail()
  return f
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})

afterEach(() => {
  vi.useRealTimers()
})

// ── Start ─────────────────────────────────────────────────────────────────────

describe('createSatelliteFeed — start', () => {
  it('starts idle and does nothing until start()', () => {
    const { feed, connect, log, statuses } = setup()
    expect(feed.mode).toBe('idle')
    expect(connect).not.toHaveBeenCalled()
    expect(log).toEqual([])
    expect(statuses).toEqual([])
  })

  it('goes straight to the bundled satellites when no URL is configured', () => {
    const { feed, connect, log, status } = setup(null)
    feed.start()
    expect(feed.mode).toBe('fallback')
    expect(connect).not.toHaveBeenCalled()
    expect(log).toEqual(['clear', 'screeningLost', 'startFallback'])
    expect(status()).toMatchObject({ status: 'limited', canRetry: false, nextRetryAt: null })
  })

  it('never retries when no URL is configured', () => {
    const { feed, connect } = setup(null)
    feed.start()
    feed.retryNow()
    vi.advanceTimersByTime(10 * 60_000)
    expect(connect).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('connects to the configured URL and waits for the first batch', () => {
    const { feed, connect, socket, log, status } = setup('wss://orbit.test/stream')
    feed.start()
    expect(connect).toHaveBeenCalledOnce()
    expect(socket().url).toBe('wss://orbit.test/stream')
    expect(feed.mode).toBe('connecting')
    expect(log).toEqual(['clear'])
    expect(status()).toMatchObject({ status: 'connecting', attempting: true, canRetry: true })
  })

  it('connects even when the tab starts hidden (only retries wait for it)', () => {
    const { feed, connect, change } = setup()
    change({ hidden: true })
    feed.start()
    expect(connect).toHaveBeenCalledOnce()
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
    const { feed, socket, log, status } = setup()
    feed.start()
    socket().batch(5)
    expect(feed.mode).toBe('ws')
    expect(log).toEqual(['clear', 'clear', 'paintLive:5'])
    expect(status()).toMatchObject({ status: 'live', attempting: false, lastLiveCount: 5 })
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

  it('does not publish a status for every batch', () => {
    const { feed, socket, statuses } = setup()
    feed.start()
    socket().batch()
    const n = statuses.length
    for (let i = 0; i < 10; i++) socket().batch()
    expect(statuses.length).toBe(n)
  })
})

// ── First connection ──────────────────────────────────────────────────────────

describe('createSatelliteFeed — first connection', () => {
  it('falls back right away when the first connection fails', () => {
    const f = setup()
    startDown(f)
    expect(f.feed.mode).toBe('fallback')
    expect(f.socket().closed).toBe(true)
    expect(f.log).toEqual(['clear', 'clear', 'screeningLost', 'startFallback'])
    expect(f.status()).toMatchObject({
      status: 'limited',
      attempting: false,
      nextRetryAt: T0 + 1_000,
    })
  })

  it('treats a socket that throws on creation (a malformed URL) as a failed attempt', () => {
    const f = setup()
    f.connect.mockImplementationOnce(() => {
      throw new SyntaxError('bad url')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    f.feed.start()
    expect(f.feed.mode).toBe('fallback')
    expect(f.status()).toMatchObject({ status: 'limited', nextRetryAt: T0 + 1_000 })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  // Was a known gap: a socket that stayed open without sending left the
  // globe empty forever.
  it('falls back at the 8 s deadline when a socket never sends a batch', () => {
    const { feed, socket, log } = setup()
    feed.start()
    socket().open()
    vi.advanceTimersByTime(FIRST_BATCH_DEADLINE_MS - 1)
    expect(feed.mode).toBe('connecting')
    vi.advanceTimersByTime(1)
    expect(feed.mode).toBe('fallback')
    expect(socket().closed).toBe(true)
    expect(log).toContain('startFallback')
  })
})

// ── Retrying ──────────────────────────────────────────────────────────────────

describe('createSatelliteFeed — retrying', () => {
  it('retries at 1, 2, 4, 8, 16, 32 s, then every 60 s, with no cap', () => {
    const f = startDown(setup())
    // Jump to each scheduled attempt and fail it as soon as it opens.
    for (let i = 0; i < 9; i++) {
      vi.advanceTimersByTime(f.status().nextRetryAt! - Date.now())
      f.socket().fail()
    }
    expect(f.status().nextRetryAt! - Date.now()).toBe(RETRY_MAX_MS)
    const gaps = f.openTimes().slice(1).map((t, i) => t - f.openTimes()[i])
    expect(gaps).toEqual([1, 2, 4, 8, 16, 32, 60, 60, 60])
    expect(f.feed.mode).toBe('fallback')
  })

  // Was a known gap: the bundled view never went back to live.
  it('goes live when a retry delivers a batch, stopping the bundled loop first', () => {
    const f = startDown(setup())
    vi.advanceTimersByTime(1_000)
    expect(f.connect).toHaveBeenCalledTimes(2)
    f.log.length = 0

    f.socket().batch(18_000)
    expect(f.feed.mode).toBe('ws')
    expect(f.signals[0].aborted).toBe(true)
    expect(f.log).toEqual(['stopFallback', 'clear', 'paintLive:18000'])
    expect(f.status()).toMatchObject({ status: 'live', lastLiveCount: 18_000 })
  })

  it('stays in fallback while a retry is connecting', () => {
    const f = startDown(setup())
    vi.advanceTimersByTime(1_000)
    f.socket().open()
    expect(f.feed.mode).toBe('fallback')
    expect(f.status()).toMatchObject({ status: 'limited', attempting: true, nextRetryAt: null })
  })

  it('gives each retry 8 s to deliver its first batch', () => {
    const f = startDown(setup())
    vi.advanceTimersByTime(1_000)
    const retry = f.socket()
    retry.open()
    vi.advanceTimersByTime(FIRST_BATCH_DEADLINE_MS)
    expect(retry.closed).toBe(true)
    // Second failure in a row: the next attempt comes 2 s later.
    expect(f.status()).toMatchObject({ nextRetryAt: Date.now() + 2_000 })
  })

  it('does not reset the backoff when a socket opens but dies before a batch', () => {
    const f = startDown(setup())
    vi.advanceTimersByTime(1_000)
    f.socket().open()
    f.socket().fail()
    vi.advanceTimersByTime(2_000)
    f.socket().open()
    f.socket().fail()
    expect(f.openTimes()).toEqual([0, 1, 3])
    expect(f.status()).toMatchObject({ nextRetryAt: Date.now() + 4_000 })
  })

  it('ignores anything a replaced socket still sends', () => {
    const f = startDown(setup())
    const dead = f.socket()
    vi.advanceTimersByTime(1_000)
    dead.batch()
    dead.conjunctions()
    dead.fail()
    expect(f.feed.mode).toBe('fallback')
    expect(f.log.some((l) => l.startsWith('paintLive') || l.startsWith('conjunctions'))).toBe(false)
    expect(f.connect).toHaveBeenCalledTimes(2)
  })

  it('drops conjunction batches while in fallback', () => {
    const f = startDown(setup())
    vi.advanceTimersByTime(1_000)
    f.socket().conjunctions()
    expect(f.log.some((l) => l.startsWith('conjunctions'))).toBe(false)
  })

  it('never has two sockets open at once', () => {
    const f = startDown(setup())
    expect(f.openSockets()).toBe(0)
    vi.advanceTimersByTime(1_000)
    expect(f.openSockets()).toBe(1)
    f.feed.retryNow()
    f.change({ hidden: false })
    expect(f.openSockets()).toBe(1)
    f.socket().batch()
    f.socket().fail()
    expect(f.openSockets()).toBe(1)
    vi.advanceTimersByTime(FIRST_BATCH_DEADLINE_MS)
    expect(f.openSockets()).toBeLessThanOrEqual(1)
  })
})

// ── Losing a live stream ──────────────────────────────────────────────────────

describe('createSatelliteFeed — losing a live stream', () => {
  function live() {
    const f = setup()
    f.feed.start()
    f.socket().batch(18_000)
    f.log.length = 0
    return f
  }

  it('keeps the last frame and reconnects straight away', () => {
    const f = live()
    f.socket().fail()
    expect(f.feed.mode).toBe('reconnecting')
    expect(f.connect).toHaveBeenCalledTimes(2)
    expect(f.log).toEqual([])
    expect(f.status()).toMatchObject({ status: 'reconnecting', attempting: true, lastLiveCount: 18_000 })
  })

  it('never shows the bundled view when the reconnect lands within the grace', () => {
    const f = live()
    f.socket().fail()
    vi.advanceTimersByTime(DROP_GRACE_MS - 1)
    f.socket().batch(18_001)
    expect(f.feed.mode).toBe('ws')
    expect(f.log).toEqual(['clear', 'paintLive:18001'])
    vi.advanceTimersByTime(60_000)
    expect(f.log).not.toContain('startFallback')
  })

  it('falls back when the grace runs out, keeping the reconnect going', () => {
    const f = live()
    f.socket().fail()
    const retry = f.socket()
    vi.advanceTimersByTime(DROP_GRACE_MS)
    expect(f.feed.mode).toBe('fallback')
    expect(f.log).toEqual(['clear', 'screeningLost', 'startFallback'])
    expect(retry.closed).toBe(false)
    retry.batch()
    expect(f.feed.mode).toBe('ws')
  })

  it('retries every 0.5 s during the grace without growing the backoff', () => {
    const f = live()
    f.socket().fail() // drop → immediate reconnect
    f.socket().fail() // which fails
    expect(f.feed.mode).toBe('reconnecting')
    expect(f.status()).toMatchObject({ nextRetryAt: Date.now() + GRACE_RETRY_MS })
    vi.advanceTimersByTime(GRACE_RETRY_MS)
    f.socket().fail()
    expect(f.status()).toMatchObject({ nextRetryAt: Date.now() + GRACE_RETRY_MS })
  })

  // Found by the live check: with the server back after 1.5 s, the attempts
  // at 0 and 1 s failed and the next came at ~3 s, just as the grace ended,
  // so the bundled view flashed up for a moment.
  it('recovers inside the grace from a drop longer than one retry', () => {
    const f = live()
    f.socket().fail() // drop → immediate reconnect
    f.socket().fail() // server still down
    vi.advanceTimersByTime(GRACE_RETRY_MS)
    f.socket().fail() // still down at 0.5 s
    vi.advanceTimersByTime(GRACE_RETRY_MS)
    f.socket().fail() // still down at 1.0 s
    vi.advanceTimersByTime(GRACE_RETRY_MS)
    f.socket().batch() // back at 1.5 s
    expect(f.feed.mode).toBe('ws')
    vi.advanceTimersByTime(60_000)
    expect(f.log).not.toContain('startFallback')
  })

  it('backs off from 1 s once the grace has run out', () => {
    const f = live()
    f.socket().fail()
    // Every attempt during the grace fails at once.
    while (f.feed.mode === 'reconnecting') {
      f.socket().fail()
      vi.advanceTimersByTime(f.status().nextRetryAt! - Date.now())
    }
    expect(f.feed.mode).toBe('fallback')
    f.socket().fail()
    expect(f.status()).toMatchObject({ nextRetryAt: Date.now() + 1_000 })
  })

  it('starts the backoff over after the stream was live again', () => {
    const f = startDown(setup())
    vi.advanceTimersByTime(1_000)
    f.socket().fail()
    vi.advanceTimersByTime(2_000)
    f.socket().batch()
    expect(f.feed.mode).toBe('ws')

    f.socket().fail() // drop → immediate reconnect
    vi.advanceTimersByTime(DROP_GRACE_MS) // grace runs out with that attempt still open
    f.socket().fail() // which fails → 1 s, not 4 s
    expect(f.status()).toMatchObject({ nextRetryAt: Date.now() + 1_000 })
  })
})

// ── Hidden tab, offline, Retry now ────────────────────────────────────────────

describe('createSatelliteFeed — when to try', () => {
  it('holds retries while the tab is hidden and tries as soon as it is visible', () => {
    const f = startDown(setup())
    f.change({ hidden: true })
    vi.advanceTimersByTime(10 * 60_000)
    expect(f.connect).toHaveBeenCalledOnce()
    expect(f.status()).toMatchObject({ status: 'limited', nextRetryAt: null, attempting: false })

    f.change({ hidden: false })
    expect(f.connect).toHaveBeenCalledTimes(2)
  })

  it('holds retries while offline and tries as soon as the network is back', () => {
    const f = startDown(setup())
    f.change({ offline: true })
    expect(f.status()).toMatchObject({ offline: true })
    vi.advanceTimersByTime(10 * 60_000)
    expect(f.connect).toHaveBeenCalledOnce()

    f.change({ offline: false })
    expect(f.connect).toHaveBeenCalledTimes(2)
    expect(f.status()).toMatchObject({ offline: false, attempting: true })
  })

  it('tries right away when the tab comes back, without waiting out the timer', () => {
    const f = startDown(setup())
    vi.advanceTimersByTime(1_000)
    f.socket().fail()
    vi.advanceTimersByTime(1_000)
    f.change({ hidden: false })
    expect(f.openTimes()).toEqual([0, 1, 2])
    // The skipped timer doesn't fire a second attempt later.
    f.socket().open()
    vi.advanceTimersByTime(1_000)
    expect(f.connect).toHaveBeenCalledTimes(3)
  })

  it('retryNow() tries at once and cancels the pending timer', () => {
    const f = startDown(setup())
    f.feed.retryNow()
    expect(f.connect).toHaveBeenCalledTimes(2)
    expect(f.status()).toMatchObject({ attempting: true, nextRetryAt: null })
    vi.advanceTimersByTime(1_000)
    expect(f.connect).toHaveBeenCalledTimes(2)
  })

  it('retryNow() does nothing while an attempt is running or while live', () => {
    const f = setup()
    f.feed.start()
    f.feed.retryNow()
    expect(f.connect).toHaveBeenCalledOnce()
    f.socket().batch()
    f.feed.retryNow()
    expect(f.connect).toHaveBeenCalledOnce()
  })

  it('retryNow() waits for the network while offline', () => {
    const f = startDown(setup())
    f.change({ offline: true })
    f.feed.retryNow()
    expect(f.connect).toHaveBeenCalledOnce()
  })

  it('ignores tab and network changes while live', () => {
    const f = setup()
    f.feed.start()
    f.socket().batch()
    f.change({ hidden: true })
    f.change({ hidden: false })
    f.change({ offline: false })
    expect(f.connect).toHaveBeenCalledOnce()
    expect(f.feed.mode).toBe('ws')
  })
})

// ── Stop ──────────────────────────────────────────────────────────────────────

describe('createSatelliteFeed — stop', () => {
  it('closes the socket, clears the screen, and leaves no timers or listeners', () => {
    const f = startDown(setup())
    vi.advanceTimersByTime(1_000)
    const retry = f.socket()
    f.log.length = 0

    f.feed.stop()
    expect(f.feed.mode).toBe('idle')
    expect(retry.closed).toBe(true)
    expect(f.log).toEqual(['stopFallback', 'clear', 'screeningLost'])
    expect(vi.getTimerCount()).toBe(0)
    expect(f.listeners.size).toBe(0)
    expect(f.status()).toMatchObject({ status: 'off', attempting: false, nextRetryAt: null })
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
    const { feed, log, statuses } = setup()
    feed.stop()
    expect(log).toEqual([])
    expect(statuses).toEqual([])
  })
})
