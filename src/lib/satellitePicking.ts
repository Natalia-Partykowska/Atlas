import type { Map as MapLibreMap } from 'maplibre-gl'
import type { SatPosition } from './satellites'

const R_EARTH_KM = 6378.137

/**
 * Cull satellites on the far hemisphere of the globe so they can't win the
 * nearest-pick over the satellite the user is actually hovering. `map.project()`
 * happily returns valid canvas coords for back-face points too, so this is the
 * only cheap way to know.
 *
 * Pass `cameraCenter` (≈ `map.getCenter()`) only in globe mode; in flat mode
 * leave it `null` and the function skips the cull.
 *
 * Includes an altitude allowance: a satellite at altitude h is visible from the
 * camera even when the foot of its sub-point lies behind the limb. The exact
 * threshold is `dot > -sqrt(1 - 1/r²)` where `r = 1 + h/R_earth`. For ISS that
 * extends visibility to ~110° from camera; for GEO to ~171°.
 */
export function pickNearestSatellite(
  map: MapLibreMap,
  point: { x: number; y: number },
  positions: Map<number, SatPosition>,
  pixelRadius = 12,
  cameraCenter: { lng: number; lat: number } | null = null,
): SatPosition | null {
  if (positions.size === 0) return null

  const canvas = map.getCanvas()
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  // Sats projected just outside the canvas can still have a visible dot
  // poking back in (the rendered point sprite has size). Allow a buffer.
  const offCanvasMargin = 50
  const radiusSq = pixelRadius * pixelRadius

  let camX = 0
  let camY = 0
  let camZ = 0
  // In globe mode the caller passes the camera center (≈ map.getCenter()) —
  // it drives the back-face cull AND the altitude offset below. In flat mode
  // it's null, both corrections are skipped, and `map.project` is exact.
  const useGlobeCorrections = cameraCenter !== null
  let centerX = 0
  let centerY = 0
  if (cameraCenter) {
    const lat = (cameraCenter.lat * Math.PI) / 180
    const lng = (cameraCenter.lng * Math.PI) / 180
    camX = Math.cos(lat) * Math.cos(lng)
    camY = Math.cos(lat) * Math.sin(lng)
    camZ = Math.sin(lat)
    const cp = map.project([cameraCenter.lng, cameraCenter.lat])
    centerX = cp.x
    centerY = cp.y
  }

  let bestSq = radiusSq
  let best: SatPosition | null = null

  for (const sat of positions.values()) {
    if (useGlobeCorrections) {
      // Back-face cull (with altitude allowance for high orbits visible above
      // the geometric limb).
      const slat = (sat.lat * Math.PI) / 180
      const slng = (sat.lng * Math.PI) / 180
      const sx = Math.cos(slat) * Math.cos(slng)
      const sy = Math.cos(slat) * Math.sin(slng)
      const sz = Math.sin(slat)
      const dot = camX * sx + camY * sy + camZ * sz
      const r = 1 + sat.altitudeKm / R_EARTH_KM
      const threshold = -Math.sqrt(Math.max(0, 1 - 1 / (r * r)))
      if (dot < threshold) continue
    }

    const projected = map.project([sat.lng, sat.lat])
    let px = projected.x
    let py = projected.y

    if (useGlobeCorrections && sat.altitudeKm > 0) {
      // Sub-point projection lands the marker on the globe's surface, but
      // the rendered dot is at altitude — visually offset radially outward
      // from the globe's screen center by ~(1 + alt/R). Orthographic-equivalent
      // approximation; close enough to the perspective truth for picking,
      // and crucially solves the "GEO sats hanging beside the globe are
      // unclickable" case where sub-point and rendered dot can be hundreds of
      // pixels apart.
      const r = 1 + sat.altitudeKm / R_EARTH_KM
      px = centerX + r * (px - centerX)
      py = centerY + r * (py - centerY)
    }

    if (
      px < -offCanvasMargin ||
      py < -offCanvasMargin ||
      px > w + offCanvasMargin ||
      py > h + offCanvasMargin
    )
      continue

    const dx = px - point.x
    const dy = py - point.y
    const dSq = dx * dx + dy * dy
    if (dSq < bestSq) {
      bestSq = dSq
      best = sat
    }
  }

  return best
}
