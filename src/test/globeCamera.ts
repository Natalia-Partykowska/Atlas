// Test-only: a globe camera built the way MapLibre builds it, so the
// projector and the picker can be tested without WebGL.
import { mat4 } from 'gl-matrix'
import { ALTITUDE_SCALE, GLOBE_RADIUS_M } from '@/lib/satelliteProjection'
import type { ProjectionFrame, ScreenPoint, ScreenProjector } from '@/lib/satelliteProjection'

const FOV = 0.6435011087932844 // MapLibre's default field of view (transform_helper.ts)
const DEG = Math.PI / 180

export const CANVAS = { width: 1440, height: 900 }

export interface GlobeCamera {
  frame: ProjectionFrame
  cameraToCenterDistance: number
  globeRadiusPx: number
}

// MapLibre 5.19's `VerticalPerspectiveTransform._calcMatrices`, with no pitch,
// bearing, roll or centre offset (Atlas uses none of them).
export function makeGlobeCamera(zoom: number, [lng, lat]: [number, number]): GlobeCamera {
  const { width, height } = CANVAS
  const cameraToCenterDistance = (0.5 / Math.tan(FOV / 2)) * height
  const globeRadiusPx = (512 * 2 ** zoom) / (2 * Math.PI) / Math.cos(lat * DEG)
  const m = new Float64Array(16)
  mat4.perspective(m, FOV, width / height, 0.5, cameraToCenterDistance + globeRadiusPx * 2)
  mat4.translate(m, m, [0, 0, -cameraToCenterDistance])
  mat4.translate(m, m, [0, 0, -globeRadiusPx])
  mat4.rotateX(m, m, lat * DEG)
  mat4.rotateY(m, m, -lng * DEG)
  mat4.scale(m, m, [globeRadiusPx, globeRadiusPx, globeRadiusPx])
  return { frame: { mainMatrix: m, transition: 1 }, cameraToCenterDistance, globeRadiusPx }
}

/** The projector's result as a value, or null when nothing is drawn. */
export function at(project: ScreenProjector, lng: number, lat: number, altitudeKm: number): ScreenPoint | null {
  const out = { x: 0, y: 0 }
  return project(lng, lat, altitudeKm, out) ? out : null
}

/**
 * Closed-form perspective offset from the canvas centre for a point
 * `angleDeg` from the view centre along the equator (or the meridian): the
 * sphere's centre is D + R in front of the camera and the focal length is D px.
 */
export function perspectiveOffsetPx(cam: GlobeCamera, angleDeg: number, altitudeKm: number): number {
  const k = 1 + (altitudeKm * 1000 * ALTITUDE_SCALE) / GLOBE_RADIUS_M
  const R = cam.globeRadiusPx
  const D = cam.cameraToCenterDistance
  const a = angleDeg * DEG
  return (D * R * k * Math.sin(a)) / (D + R - R * k * Math.cos(a))
}
