import type { SatPosition } from './satellites'
import type { ScreenPoint } from './satelliteProjection'

/**
 * Keeps the satellite hover true to what's under the pointer.
 *
 * A pointer move is picked on the next animation frame (several moves in one
 * frame make one pick). With the pointer still, the scene can still move under
 * it — the globe turns, the camera eases, satellites move each position batch,
 * and zoomed in, LEO satellites near the camera's height cross the screen at
 * 100+ px/s. Those scene changes re-pick at the last pointer position, at most
 * every SCENE_REPICK_MS (a pick costs ~1 ms for ~18k satellites).
 *
 * Framework-free: Map.tsx feeds it pointer and scene events and draws what
 * `onChange` reports.
 */

/** How often a still pointer's hover is re-picked while the scene moves. */
export const SCENE_REPICK_MS = 100

export interface SatelliteHover {
  sat: SatPosition
  /** The pointer, in CSS px — where the tooltip goes. */
  point: ScreenPoint
}

export interface AnimationFrames {
  request: (cb: () => void) => number
  cancel: (id: number) => void
}

const browserFrames: AnimationFrames = {
  request: (cb) => requestAnimationFrame(cb),
  cancel: (id) => cancelAnimationFrame(id),
}

export interface SatelliteHoverTrackerOptions {
  /** The satellite drawn under a CSS-px point, or null. */
  pick: (point: ScreenPoint) => SatPosition | null
  /** The hovered satellite or the pointer changed; null clears the hover. */
  onChange: (hover: SatelliteHover | null) => void
  /** Injected in tests; the browser's animation frames otherwise. */
  frames?: AnimationFrames
}

export interface SatelliteHoverTracker {
  pointerMove: (point: ScreenPoint) => void
  /** The pointer left the map: clears the hover. */
  pointerLeave: () => void
  /** The camera or the satellites moved: re-pick under a still pointer. */
  sceneChanged: () => void
  /** Satellites or the globe turned off: clears the hover and the pointer. */
  reset: () => void
  dispose: () => void
}

export function createSatelliteHoverTracker({
  pick,
  onChange,
  frames = browserFrames,
}: SatelliteHoverTrackerOptions): SatelliteHoverTracker {
  let pointer: ScreenPoint | null = null
  let frameId: number | null = null
  let waitTimer: ReturnType<typeof setTimeout> | null = null
  let lastPickAt = -Infinity
  // What onChange last reported, so an unchanged pick reports nothing.
  let shown: { norad: number; x: number; y: number } | null = null
  let disposed = false

  const cancelPending = () => {
    if (frameId !== null) {
      frames.cancel(frameId)
      frameId = null
    }
    if (waitTimer !== null) {
      clearTimeout(waitTimer)
      waitTimer = null
    }
  }

  const hide = () => {
    if (shown === null) return
    shown = null
    onChange(null)
  }

  const runPick = () => {
    frameId = null
    if (!pointer) return
    lastPickAt = Date.now()
    const sat = pick(pointer)
    if (!sat) {
      hide()
      return
    }
    const { x, y } = pointer
    if (shown && shown.norad === sat.norad && shown.x === x && shown.y === y) return
    shown = { norad: sat.norad, x, y }
    onChange({ sat, point: { x, y } })
  }

  const requestPick = () => {
    if (frameId === null) frameId = frames.request(runPick)
  }

  const clear = () => {
    cancelPending()
    pointer = null
    hide()
  }

  return {
    pointerMove(point) {
      if (disposed) return
      pointer = { x: point.x, y: point.y }
      // This frame's pick covers any scene change still waiting.
      if (waitTimer !== null) {
        clearTimeout(waitTimer)
        waitTimer = null
      }
      requestPick()
    },
    pointerLeave() {
      if (!disposed) clear()
    },
    sceneChanged() {
      if (disposed || !pointer) return
      if (frameId !== null || waitTimer !== null) return // a pick is already coming
      const wait = lastPickAt + SCENE_REPICK_MS - Date.now()
      if (wait <= 0) {
        requestPick()
        return
      }
      waitTimer = setTimeout(() => {
        waitTimer = null
        requestPick()
      }, wait)
    },
    reset() {
      if (!disposed) clear()
    },
    dispose() {
      cancelPending()
      pointer = null
      disposed = true
    },
  }
}
