import type { Feature, Polygon } from 'geojson'

const DEG = Math.PI / 180
const RAD = 180 / Math.PI

export function getDayOfYear(date: Date): number {
  const start = new Date(Date.UTC(date.getUTCFullYear(), 0, 0))
  return Math.floor((date.getTime() - start.getTime()) / 86400000)
}

/**
 * Compute the subsolar point — the lat/lng where the sun is directly overhead.
 * Returns [lng, lat] in degrees.
 */
export function subsolarPoint(date: Date): [number, number] {
  const doy = getDayOfYear(date)
  const utcHours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600

  // Solar declination using a simple approximation
  const declination = -23.44 * Math.cos(((2 * Math.PI) / 365) * (doy + 10))

  // Longitude where the sun is directly overhead (solar noon)
  let solarLng = (12 - utcHours) * 15
  // Normalize to [-180, 180]
  solarLng = ((solarLng + 180 + 360) % 360) - 180

  return [solarLng, declination]
}

/**
 * Generate the solar terminator as a GeoJSON Polygon covering the night side.
 *
 * Approach: for each longitude from -180° to +180°, compute the terminator
 * latitude using the condition that the solar zenith angle = 90°:
 *   tan(φ) = -cos(λ - λ_s) * cos(φ_s) / sin(φ_s)
 *
 * This gives one lat per lng. We then close the polygon through the night-side pole.
 */
export function computeTerminator(date: Date, numPoints = 360): Feature<Polygon> {
  const [lng0, lat0] = subsolarPoint(date)
  const phiS = lat0 * DEG
  const lamS = lng0 * DEG

  const terminatorPts: [number, number][] = []

  for (let i = 0; i <= numPoints; i++) {
    const lam = -Math.PI + (2 * Math.PI * i) / numPoints // -π … +π
    let phi: number

    if (Math.abs(Math.sin(phiS)) < 1e-6) {
      // Near equinox: avoid division by zero; use ±90 to mark pole-reaching terminator
      phi = Math.cos(lam - lamS) >= 0 ? -Math.PI / 2 : Math.PI / 2
    } else {
      phi = Math.atan((-Math.cos(lam - lamS) * Math.cos(phiS)) / Math.sin(phiS))
    }

    const latDeg = phi * RAD
    const lngDeg = lam * RAD
    terminatorPts.push([lngDeg, latDeg])
  }

  // Night pole: if sun is in north (lat0 > 0), south pole is in night; and vice versa
  const nightPole = lat0 >= 0 ? -90 : 90

  // Build polygon: go from (-180, nightPole) → terminator curve → (180, nightPole) → close
  const coords: [number, number][] = [
    [-180, nightPole],
    ...terminatorPts,
    [180, nightPole],
    [-180, nightPole],
  ]

  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [coords],
    },
  }
}
