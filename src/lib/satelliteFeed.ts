import { connectOrbitStream } from './orbitStream'
import type { ConjunctionEvent, OrbitStreamHandle, ViewportBounds } from './orbitStream'
import {
  DROP_GRACE_MS,
  FIRST_BATCH_DEADLINE_MS,
  GRACE_RETRY_MS,
  retryDelayMs,
  withJitter,
} from './orbitReconnect'
import type { SatPosition } from './satellites'

// Decides where the globe's satellite positions come from: the live orbit
// server (WebSocket) or the bundled satellites propagated in the browser, and
// keeps trying to get back to the server while it's on the bundled ones.
//
// It holds no MapLibre state. Map.tsx passes in hooks that do the drawing, so
// this module owns only the decisions: which source is on screen, when to
// give up on a connection, when to try again, and in what order to hand over
// between the two writers.
//
// The mode is the single source of truth for who may write to the satellite
// layer. Every transition goes through `enter()`, which stops the old writer
// before the new one starts, so two writers never race on the same layer.
//
// Modes:
//   connecting    first connection, nothing on screen yet
//   ws            live batches from the server
//   reconnecting  the live stream dropped; its last frame stays on screen for
//                 a 3 s grace while it retries every 0.5 s
//   fallback      the bundled satellites; retries run in the background
//
// Connections are separate from modes: at most one socket exists at a time.
// An attempt succeeds only when its first position batch arrives (not when it
// opens), so a server that accepts and then dies doesn't reset the backoff.

export type SatelliteFeedMode = 'idle' | 'connecting' | 'ws' | 'reconnecting' | 'fallback'

/** What the UI shows about the feed. `limited` = the bundled satellites. */
export type SatelliteFeedStatus = 'off' | 'connecting' | 'live' | 'reconnecting' | 'limited'

export interface SatelliteFeedState {
  status: SatelliteFeedStatus
  /** When the next attempt starts (epoch ms), or null when none is scheduled:
   *  an attempt is running, retries are on hold, or there's nothing to retry. */
  nextRetryAt: number | null
  /** A connection attempt is running and hasn't delivered a batch yet. */
  attempting: boolean
  /** An orbit server is configured, so there is something to retry. */
  canRetry: boolean
  /** Retries are on hold because the browser is offline. */
  offline: boolean
  /** Satellites in the most recent live batch, or null before the first. */
  lastLiveCount: number | null
}

export const SATELLITE_FEED_OFF: SatelliteFeedState = {
  status: 'off',
  nextRetryAt: null,
  attempting: false,
  canRetry: false,
  offline: false,
  lastLiveCount: null,
}

const STATUS_BY_MODE: Record<SatelliteFeedMode, SatelliteFeedStatus> = {
  idle: 'off',
  connecting: 'connecting',
  ws: 'live',
  reconnecting: 'reconnecting',
  fallback: 'limited',
}

export interface SatelliteFeedHooks {
  /** Draw one batch from the server. Called only in `ws`. */
  paintLive: (positions: SatPosition[]) => void
  /** Start drawing the bundled satellites. `signal` aborts when the feed
   *  leaves `fallback`; the loop and any pending fetch must stop then. */
  startFallback: (signal: AbortSignal) => void
  /** Flush the satellite layer. Called on every transition except a live
   *  stream dropping, whose last frame stays up during the grace. */
  clear: () => void
  /** Conjunction screening needs the server: drop the list and its overlays.
   *  Called on entering `fallback` and `idle`. */
  screeningLost: () => void
  /** A conjunction batch from the server. Dropped in `fallback`. */
  conjunctions: (events: ConjunctionEvent[]) => void
  /** The feed's state changed. Not called for every batch. */
  status: (state: SatelliteFeedState) => void
}

/** The tab and network state that decide when a retry may run. */
export interface SatelliteFeedBrowser {
  isHidden: () => boolean
  isOffline: () => boolean
  /** Calls `onChange` when either of the above may have changed. Returns an
   *  unsubscribe function. */
  subscribe: (onChange: () => void) => () => void
}

/** The real tab and network. */
export const browserEnvironment: SatelliteFeedBrowser = {
  isHidden: () => document.visibilityState === 'hidden',
  isOffline: () => !navigator.onLine,
  subscribe: (onChange) => {
    document.addEventListener('visibilitychange', onChange)
    window.addEventListener('online', onChange)
    window.addEventListener('offline', onChange)
    return () => {
      document.removeEventListener('visibilitychange', onChange)
      window.removeEventListener('online', onChange)
      window.removeEventListener('offline', onChange)
    }
  },
}

export interface SatelliteFeedOptions {
  /** The orbit server's WebSocket URL; without one the feed uses the bundled
   *  satellites only. */
  url: string | undefined
  hooks: SatelliteFeedHooks
  /** The area to ask the server for, sent on connect and on `syncViewport()`. */
  viewport: () => ViewportBounds
  /** Opens one socket; replaced in tests. */
  connect?: typeof connectOrbitStream
  /** Tab and network state; replaced in tests. */
  browser?: SatelliteFeedBrowser
  /** Jitter source for the retry delays; replaced in tests. */
  random?: () => number
}

export interface SatelliteFeed {
  readonly mode: SatelliteFeedMode
  start: () => void
  stop: () => void
  /** Try the server now instead of waiting for the next scheduled attempt.
   *  Does nothing while live, while an attempt is running, or while offline. */
  retryNow: () => void
  /** Sends the current viewport to the server, if the stream is live. */
  syncViewport: () => void
}

export function createSatelliteFeed({
  url,
  hooks,
  viewport,
  connect = connectOrbitStream,
  browser = browserEnvironment,
  random = Math.random,
}: SatelliteFeedOptions): SatelliteFeed {
  let mode: SatelliteFeedMode = 'idle'
  let started = false
  let fallback: AbortController | null = null
  let graceTimer: ReturnType<typeof setTimeout> | null = null

  // The current socket (an attempt, or the live stream once it has sent a
  // batch). `generation` changes whenever a socket is dropped, so callbacks
  // from a replaced socket are ignored.
  let socket: OrbitStreamHandle | null = null
  let generation = 0
  let gotBatch = false
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null

  // Consecutive failed attempts; picks the backoff step. Reset by a batch.
  let failures = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let nextRetryAt: number | null = null

  let liveCount: number | null = null
  let unsubscribeBrowser: (() => void) | null = null
  let lastPublished: SatelliteFeedState | null = null

  const publish = () => {
    const next: SatelliteFeedState = {
      status: STATUS_BY_MODE[mode],
      nextRetryAt,
      attempting: socket !== null && !gotBatch,
      canRetry: Boolean(url),
      offline: browser.isOffline(),
      lastLiveCount: liveCount,
    }
    const prev = lastPublished
    if (
      prev &&
      (Object.keys(next) as (keyof SatelliteFeedState)[]).every((k) => prev[k] === next[k])
    ) {
      return
    }
    lastPublished = next
    hooks.status(next)
  }

  const clearGrace = () => {
    if (graceTimer !== null) {
      clearTimeout(graceTimer)
      graceTimer = null
    }
  }

  const clearRetryTimer = () => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    nextRetryAt = null
  }

  const closeSocket = () => {
    if (deadlineTimer !== null) {
      clearTimeout(deadlineTimer)
      deadlineTimer = null
    }
    generation++
    socket?.close()
    socket = null
    gotBatch = false
  }

  // Single funnel for all mode transitions. Tear down before arming.
  const enter = (next: SatelliteFeedMode) => {
    if (mode === next) return
    const prev = mode

    // Exit: stop the writer and timer the previous mode could have armed.
    // Connection timers (deadline, retry) belong to the socket, not the mode.
    clearGrace()
    fallback?.abort()
    fallback = null

    mode = next

    // Flush stale paint so the new writer's first frame is clean — except
    // when a live stream drops: its last frame stays up during the grace.
    if (!(prev === 'ws' && next === 'reconnecting')) hooks.clear()

    switch (next) {
      case 'idle':
        hooks.screeningLost()
        break
      case 'reconnecting':
        graceTimer = setTimeout(() => {
          graceTimer = null
          if (mode === 'reconnecting') enter('fallback')
        }, DROP_GRACE_MS)
        break
      case 'fallback':
        // The bundled satellites come with no screener, so drop stale events
        // and let the panel say there's no live data.
        hooks.screeningLost()
        fallback = new AbortController()
        hooks.startFallback(fallback.signal)
        break
      case 'connecting':
      case 'ws':
        break
    }
    publish()
  }

  const onPositions = (positions: SatPosition[]) => {
    if (mode === 'idle') return
    if (!gotBatch) {
      // This attempt succeeded.
      gotBatch = true
      failures = 0
      if (deadlineTimer !== null) {
        clearTimeout(deadlineTimer)
        deadlineTimer = null
      }
    }
    liveCount = positions.length
    if (mode !== 'ws') enter('ws')
    hooks.paintLive(positions)
  }

  const onConjunctions = (events: ConjunctionEvent[]) => {
    // No live positions to anchor the 3D lines in fallback, and the events
    // would mislead about what's still in the window.
    if (mode === 'idle' || mode === 'fallback') return
    hooks.conjunctions(events)
  }

  const scheduleRetry = (delay: number) => {
    clearRetryTimer()
    nextRetryAt = Date.now() + delay
    retryTimer = setTimeout(() => {
      retryTimer = null
      nextRetryAt = null
      retry()
    }, delay)
    publish()
  }

  // The socket failed: it closed, errored, or missed its first-batch deadline.
  const onSocketFailed = () => {
    const wasLive = mode === 'ws'
    closeSocket()
    if (mode === 'idle') return
    if (wasLive) {
      // Keep the last frame and reconnect straight away; the grace decides
      // when to show the bundled satellites instead.
      failures = 0
      enter('reconnecting')
      retry()
      return
    }
    if (mode === 'reconnecting') {
      // Still inside the grace: retry quickly without growing the backoff, so
      // a drop shorter than the grace never shows the bundled satellites.
      scheduleRetry(withJitter(GRACE_RETRY_MS, random()))
      return
    }
    failures++
    if (mode === 'connecting') enter('fallback')
    scheduleRetry(retryDelayMs(failures - 1, random()))
  }

  const openSocket = () => {
    const gen = ++generation
    gotBatch = false
    // Callbacks from a socket that has since been replaced are ignored.
    const current =
      <A extends unknown[]>(fn: (...args: A) => void) =>
      (...args: A) => {
        if (gen === generation) fn(...args)
      }
    try {
      socket = connect(url!, {
        onPositions: current(onPositions),
        onConjunctions: current(onConjunctions),
        onConnect: current(() => socket?.updateViewport(viewport())),
        onDisconnect: current(onSocketFailed),
      })
    } catch (err) {
      // `new WebSocket` throws on a malformed URL. Count it as a failed
      // attempt rather than taking the effect down with it.
      console.warn('[satellite-feed] could not open the orbit stream:', err)
      onSocketFailed()
      return
    }
    deadlineTimer = setTimeout(
      current(() => {
        deadlineTimer = null
        if (!gotBatch) onSocketFailed()
      }),
      FIRST_BATCH_DEADLINE_MS,
    )
    publish()
  }

  // A retry, from the timer, Retry now, or the tab/network coming back. Waits
  // while the tab is hidden or the browser is offline; the browser change
  // that ends the wait calls this again.
  function retry() {
    if (!url || socket) return
    if (mode !== 'reconnecting' && mode !== 'fallback') return
    clearRetryTimer()
    if (browser.isHidden() || browser.isOffline()) {
      publish()
      return
    }
    openSocket()
  }

  return {
    get mode() {
      return mode
    },

    start() {
      if (started) return
      started = true
      if (!url) {
        enter('fallback')
        return
      }
      // The tab showing again or the network coming back ends a wait (or
      // skips the rest of it); going offline shows in the published state.
      unsubscribeBrowser = browser.subscribe(() => {
        retry()
        publish()
      })
      enter('connecting')
      // The first connection doesn't wait for the tab or the network: if it
      // can't connect it fails fast and the bundled satellites show.
      openSocket()
    },

    stop() {
      closeSocket()
      clearRetryTimer()
      unsubscribeBrowser?.()
      unsubscribeBrowser = null
      enter('idle')
    },

    retryNow: retry,

    syncViewport() {
      if (mode === 'ws') socket?.updateViewport(viewport())
    },
  }
}
