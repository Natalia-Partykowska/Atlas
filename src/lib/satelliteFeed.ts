import { connectOrbitStream } from './orbitStream'
import type { ConjunctionEvent, OrbitStreamHandle, ViewportBounds } from './orbitStream'
import { DROP_GRACE_MS, FIRST_BATCH_DEADLINE_MS } from './orbitReconnect'
import type { SatPosition } from './satellites'

// Decides where the globe's satellite positions come from: the live orbit
// server (WebSocket) or the bundled satellites propagated in the browser.
//
// It holds no MapLibre state. Map.tsx passes in hooks that do the drawing, so
// this module owns only the decisions: which source is live, when to give up
// on the server, and in what order to hand over between the two writers.
//
// The mode is the single source of truth for who may write to the satellite
// layer. Every transition goes through `enter()`, which stops the old writer
// before the new one starts, so two writers never race on the same layer.

export type SatelliteFeedMode = 'idle' | 'connecting' | 'ws' | 'fallback'

export interface SatelliteFeedHooks {
  /** Draw one batch from the server. Called only in `ws`. */
  paintLive: (positions: SatPosition[]) => void
  /** Start drawing the bundled satellites. `signal` aborts when the feed
   *  leaves `fallback`; the loop and any pending fetch must stop then. */
  startFallback: (signal: AbortSignal) => void
  /** Flush the satellite layer. Called on every transition. */
  clear: () => void
  /** Conjunction screening needs the server: drop the list and its overlays.
   *  Called on entering `fallback` and `idle`. */
  screeningLost: () => void
  /** A conjunction batch from the server. Passed on only while connected. */
  conjunctions: (events: ConjunctionEvent[]) => void
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
}

export interface SatelliteFeed {
  readonly mode: SatelliteFeedMode
  start: () => void
  stop: () => void
  /** Sends the current viewport to the server, if the stream is live. */
  syncViewport: () => void
}

export function createSatelliteFeed({
  url,
  hooks,
  viewport,
  connect = connectOrbitStream,
}: SatelliteFeedOptions): SatelliteFeed {
  let mode: SatelliteFeedMode = 'idle'
  let started = false
  let socket: OrbitStreamHandle | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let fallback: AbortController | null = null

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  // Single funnel for all mode transitions. Tear down before arming.
  const enter = (next: SatelliteFeedMode) => {
    if (mode === next) return

    // Exit: stop every writer and timer the previous mode could have armed.
    clearTimer()
    fallback?.abort()
    fallback = null

    mode = next

    // Flush any stale paint so the new writer's first frame is clean.
    hooks.clear()

    switch (next) {
      case 'idle':
        hooks.screeningLost()
        break
      case 'connecting':
        // 8 s budget for the handshake + first batch. Railway cold starts can
        // take several seconds; while the socket is still connecting or open
        // we hold off, otherwise fall back.
        timer = setTimeout(() => {
          timer = null
          if (mode !== 'connecting') return
          if (socket?.isLive()) return
          enter('fallback')
        }, FIRST_BATCH_DEADLINE_MS)
        break
      case 'ws':
        // The first batch paints right after this returns.
        break
      case 'fallback':
        // The bundled satellites come with no screener, so drop stale events
        // and let the panel say there's no live data.
        hooks.screeningLost()
        fallback = new AbortController()
        hooks.startFallback(fallback.signal)
        break
    }
  }

  const onPositions = (positions: SatPosition[]) => {
    // Drop stragglers that arrive after leaving the states that take them.
    if (mode === 'idle' || mode === 'fallback') return
    if (mode !== 'ws') enter('ws')
    hooks.paintLive(positions)
  }

  const onConjunctions = (events: ConjunctionEvent[]) => {
    // No live positions to anchor the 3D lines in fallback, and the events
    // would mislead about what's still in the window.
    if (mode === 'idle' || mode === 'fallback') return
    hooks.conjunctions(events)
  }

  const onDisconnect = () => {
    if (mode === 'idle') return
    // A grace period before falling back, so brief blips don't flap the
    // globe. Replaces any pending timer.
    clearTimer()
    timer = setTimeout(() => {
      timer = null
      if (mode === 'idle') return
      enter('fallback')
    }, DROP_GRACE_MS)
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
      socket = connect(url, {
        onPositions,
        onConjunctions,
        onConnect: () => socket?.updateViewport(viewport()),
        onDisconnect,
      })
      enter('connecting')
    },

    stop() {
      enter('idle')
      socket?.close()
      socket = null
    },

    syncViewport() {
      if (mode === 'ws') socket?.updateViewport(viewport())
    },
  }
}
