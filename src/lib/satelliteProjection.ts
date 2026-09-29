import { mat4 } from 'gl-matrix'

/**
 * Where a satellite is drawn on screen, computed on the CPU the same way the
 * GPU draws it, so picking lands on the dot the user sees.
 *
 * Mirrors MapLibre's `projectTileFor3D` for the globe
 * (`_projection_globe.vertex.glsl`, MapLibre 5.19): the point goes onto the
 * unit sphere, is lifted by its altitude, and is multiplied by the frame's
 * `mainMatrix`. If a MapLibre upgrade changes that shader or the custom-layer
 * projection data, this module has to follow; re-run the picking live check
 * (`scripts/satellite-picking-check/`) after upgrading.
 */

/** The shader's `GLOBE_RADIUS`, in metres. */
export const GLOBE_RADIUS_M = 6371008.8

/**
 * Altitude exaggeration for the satellite dots and for picking them.
 * 1.0 = true scale (3× was tried first and looked melodramatic).
 */
export const ALTITUDE_SCALE = 1.0

// MapLibre's `globe` projection only starts turning into mercator at zoom 11,
// above our maxZoom of 8, so in practice the transition is always 1.
const GLOBE_TRANSITION_DONE = 0.999

const DEG = Math.PI / 180

/** The projection data of the frame on screen, as a custom layer receives it. */
export interface ProjectionFrame {
  /** `defaultProjectionData.mainMatrix` (column-major, unit-sphere → clip space). */
  mainMatrix: Float64Array
  /** `defaultProjectionData.projectionTransition`: 1 = globe. */
  transition: number
}

export interface ScreenPoint {
  x: number
  y: number
}

/**
 * Writes the satellite's CSS-pixel position into `out` and returns true, or
 * returns false when it isn't drawn (behind the camera or the globe). The
 * out-parameter keeps the picker's ~18k calls per pick allocation-free.
 */
export type ScreenProjector = (
  lng: number,
  lat: number,
  altitudeKm: number,
  out: ScreenPoint,
) => boolean

const NOTHING_DRAWN: ScreenProjector = () => false

/**
 * The camera position in unit-sphere space. In view space the camera sits at
 * the origin, which a perspective matrix sends to clip (0, 0, c, 0), so the
 * camera is column 2 of the inverse, dehomogenised.
 */
export function recoverCameraPosition(mainMatrix: Float64Array): [number, number, number] | null {
  const inv = mat4.invert(new Float64Array(16), mainMatrix)
  if (!inv || inv[11] === 0) return null
  return [inv[8] / inv[11], inv[9] / inv[11], inv[10] / inv[11]]
}

export function createScreenProjector(
  frame: ProjectionFrame,
  cssWidth: number,
  cssHeight: number,
): ScreenProjector {
  if (frame.transition < GLOBE_TRANSITION_DONE) return NOTHING_DRAWN
  const eye = recoverCameraPosition(frame.mainMatrix)
  if (!eye) return NOTHING_DRAWN

  const m = frame.mainMatrix
  const [ex, ey, ez] = eye
  // Constant term of the segment–sphere intersection below; > 0 because the
  // camera is outside the globe.
  const eyeOutside = ex * ex + ey * ey + ez * ez - 1
  const halfW = cssWidth / 2
  const halfH = cssHeight / 2

  return (lng, lat, altitudeKm, out) => {
    const k = 1 + (altitudeKm * 1000 * ALTITUDE_SCALE) / GLOBE_RADIUS_M
    const cosLat = Math.cos(lat * DEG)
    const x = Math.sin(lng * DEG) * cosLat * k
    const y = Math.sin(lat * DEG) * k
    const z = Math.cos(lng * DEG) * cosLat * k

    const cw = m[3] * x + m[7] * y + m[11] * z + m[15]
    if (cw <= 0) return false // behind the camera

    // Hidden by the globe: the segment from the camera to the satellite
    // enters the unit sphere before it reaches the satellite.
    const dx = x - ex
    const dy = y - ey
    const dz = z - ez
    const a = dx * dx + dy * dy + dz * dz
    const b = 2 * (ex * dx + ey * dy + ez * dz)
    const disc = b * b - 4 * a * eyeOutside
    if (disc > 0) {
      const tEnter = (-b - Math.sqrt(disc)) / (2 * a)
      if (tEnter > 0 && tEnter < 1 - 1e-9) return false
    }

    const cx = m[0] * x + m[4] * y + m[8] * z + m[12]
    const cy = m[1] * x + m[5] * y + m[9] * z + m[13]
    out.x = (cx / cw + 1) * halfW
    out.y = (1 - cy / cw) * halfH
    return true
  }
}
