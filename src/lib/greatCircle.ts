const DEG = Math.PI / 180
const RAD = 180 / Math.PI
const EARTH_RADIUS_KM = 6371

/** Haversine great-circle distance in km */
export function haversineDistance(p1: [number, number], p2: [number, number]): number {
  const [lng1, lat1] = p1
  const [lng2, lat2] = p2
  const dLat = (lat2 - lat1) * DEG
  const dLng = (lng2 - lng1) * DEG
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a))
}

/** Rhumb-line (loxodrome) distance in km — the "straight line on Mercator" path */
export function rhumbDistance(p1: [number, number], p2: [number, number]): number {
  const [lng1, lat1] = p1
  const [lng2, lat2] = p2
  const phi1 = lat1 * DEG
  const phi2 = lat2 * DEG
  const dLat = phi2 - phi1
  let dLng = (lng2 - lng1) * DEG
  // Normalize to shortest crossing
  if (Math.abs(dLng) > Math.PI) dLng = dLng > 0 ? dLng - 2 * Math.PI : 2 * Math.PI + dLng
  const dPhi = Math.log(Math.tan(Math.PI / 4 + phi2 / 2) / Math.tan(Math.PI / 4 + phi1 / 2))
  const q = Math.abs(dPhi) > 1e-10 ? dLat / dPhi : Math.cos(phi1)
  return EARTH_RADIUS_KM * Math.sqrt(dLat * dLat + q * q * dLng * dLng)
}

/**
 * Spherical-linear interpolation along the great circle arc between p1 and p2.
 * Returns an array of [lng, lat] points (including endpoints).
 */
export function interpolateGreatCircle(
  p1: [number, number],
  p2: [number, number],
  numPoints = 100,
): [number, number][] {
  const [lng1, lat1] = p1
  const [lng2, lat2] = p2
  const phi1 = lat1 * DEG
  const phi2 = lat2 * DEG
  const lam1 = lng1 * DEG
  const lam2 = lng2 * DEG

  // Angular distance between points
  const d =
    2 *
    Math.asin(
      Math.sqrt(
        Math.sin((phi2 - phi1) / 2) ** 2 +
          Math.cos(phi1) * Math.cos(phi2) * Math.sin((lam2 - lam1) / 2) ** 2,
      ),
    )

  // Points are essentially the same
  if (d < 1e-10) return [p1, p2]

  const points: [number, number][] = []
  for (let i = 0; i <= numPoints; i++) {
    const f = i / numPoints
    const A = Math.sin((1 - f) * d) / Math.sin(d)
    const B = Math.sin(f * d) / Math.sin(d)
    const x = A * Math.cos(phi1) * Math.cos(lam1) + B * Math.cos(phi2) * Math.cos(lam2)
    const y = A * Math.cos(phi1) * Math.sin(lam1) + B * Math.cos(phi2) * Math.sin(lam2)
    const z = A * Math.sin(phi1) + B * Math.sin(phi2)
    const lat = Math.atan2(z, Math.sqrt(x * x + y * y)) * RAD
    const lng = Math.atan2(y, x) * RAD
    points.push([lng, lat])
  }
  return points
}

/**
 * Unwrap a path so consecutive lngs never jump more than 180°.
 * Needed for paths that cross the anti-meridian.
 */
export function unwrapPath(pts: [number, number][]): [number, number][] {
  if (pts.length === 0) return pts
  const result: [number, number][] = [[...pts[0]]]
  for (let i = 1; i < pts.length; i++) {
    let lng = pts[i][0]
    const prevLng = result[i - 1][0]
    while (lng - prevLng > 180) lng -= 360
    while (prevLng - lng > 180) lng += 360
    result.push([lng, pts[i][1]])
  }
  return result
}

/**
 * Split a path into segments at the anti-meridian (±180°).
 * Normalizes all longitudes to [-180, 180] first, then detects crossings
 * by checking if consecutive normalized points jump more than 180°.
 * MapLibre renders each segment as a separate LineString feature so the line
 * doesn't draw horizontally across the entire map.
 */
export function splitAtAntiMeridian(pts: [number, number][]): [number, number][][] {
  if (pts.length < 2) return [pts]
  const norm = (lng: number) => ((lng % 360) + 540) % 360 - 180
  const segments: [number, number][][] = []
  let current: [number, number][] = [[norm(pts[0][0]), pts[0][1]]]

  for (let i = 1; i < pts.length; i++) {
    const lng = norm(pts[i][0])
    const prev = current[current.length - 1][0]
    if (Math.abs(lng - prev) > 180) {
      segments.push(current)
      current = [[lng, pts[i][1]]]
    } else {
      current.push([lng, pts[i][1]])
    }
  }
  segments.push(current)
  return segments.filter((s) => s.length >= 2)
}
