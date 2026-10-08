import type { SatPosition } from './satellites'
import { createScreenProjector } from './satelliteProjection'
import type { ProjectionFrame } from './satelliteProjection'

/** How close (CSS px) the pointer must be to a dot to pick it. */
export const SATELLITE_PICK_RADIUS_PX = 22

/**
 * The satellite drawn nearest to `point` within `pixelRadius`, or null.
 *
 * Positions come from the same projection the GPU used for the frame on
 * screen (`SatelliteLayer.getProjectionFrame()`), so the pick is the dot the
 * user sees under the pointer. Satellites behind the camera or hidden by the
 * globe aren't drawn and can't be picked. `frame` is null until the satellite
 * layer has rendered once; nothing is picked then.
 */
export function pickNearestSatellite(
  frame: ProjectionFrame | null,
  canvas: { width: number; height: number },
  point: { x: number; y: number },
  positions: Map<number, SatPosition>,
  pixelRadius = SATELLITE_PICK_RADIUS_PX,
): SatPosition | null {
  if (!frame || positions.size === 0) return null

  const project = createScreenProjector(frame, canvas.width, canvas.height)
  const drawn = { x: 0, y: 0 }
  let bestSq = pixelRadius * pixelRadius
  let best: SatPosition | null = null

  for (const sat of positions.values()) {
    if (!project(sat.lng, sat.lat, sat.altitudeKm, drawn)) continue
    const dx = drawn.x - point.x
    const dy = drawn.y - point.y
    const dSq = dx * dx + dy * dy
    if (dSq < bestSq) {
      bestSq = dSq
      best = sat
    }
  }

  return best
}
