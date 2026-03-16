import type { Polygon, MultiPolygon, Position, FeatureCollection } from 'geojson'

const MAX_LAT = 85.051129
const MAX_Y = Math.log(Math.tan(Math.PI / 4 + (MAX_LAT * Math.PI) / 360))

export function toMercator(lng: number, lat: number): [number, number] {
  const x = (lng * Math.PI) / 180
  const y = Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))
  return [x, y]
}

export function fromMercator(x: number, y: number): [number, number] {
  const lng = (x * 180) / Math.PI
  const lat = ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI
  return [lng, lat]
}

// Removes anti-meridian discontinuities — adjusts each vertex to be within
// 180° of the previous one so offsets from centroid are always correct.
function unwrapRing(ring: Position[]): Position[] {
  if (ring.length === 0) return ring
  const out: Position[] = [ring[0]]
  for (let i = 1; i < ring.length; i++) {
    const [lng, lat, ...rest] = ring[i]
    let adjustedLng = lng
    const prevLng = out[i - 1][0]
    while (adjustedLng - prevLng > 180) adjustedLng -= 360
    while (adjustedLng - prevLng < -180) adjustedLng += 360
    out.push([adjustedLng, lat, ...rest])
  }
  return out
}

function repositionRing(
  ring: Position[],
  origCentroid: [number, number],
  newCentroid: [number, number],
  scale: number
): Position[] {
  return unwrapRing(ring).map(([lng, lat, ...rest]) => {
    let [x, y] = toMercator(lng, lat)
    // Normalize x to within ±π of the centroid. This fixes MultiPolygon parts
    // on the far side of the anti-meridian (e.g. Chukotka stored at -170°W
    // while Russia's centroid is at ~+100°E — otherwise the offset is -270°
    // instead of the correct +90°, placing Chukotka on the wrong side).
    while (x - origCentroid[0] > Math.PI) x -= 2 * Math.PI
    while (x - origCentroid[0] < -Math.PI) x += 2 * Math.PI
    const nx = newCentroid[0] + (x - origCentroid[0]) * scale
    const ny = Math.max(-MAX_Y, Math.min(MAX_Y, newCentroid[1] + (y - origCentroid[1]) * scale))
    const [nLng, nLat] = fromMercator(nx, ny)
    return [nLng, nLat, ...rest]
  })
}

export function computeMercatorCentroid(geometry: Polygon | MultiPolygon): [number, number] {
  let ring: Position[]

  if (geometry.type === 'Polygon') {
    ring = geometry.coordinates[0]
  } else {
    // Pick the part with the most vertices — anchors to the main land mass
    const largest = geometry.coordinates.reduce((best, part) =>
      part[0].length > best[0].length ? part : best
    )
    ring = largest[0]
  }

  // Unwrap before averaging so anti-meridian-spanning countries (e.g. Russia)
  // get a correct centroid rather than one pulled toward 0°E.
  const unwrapped = unwrapRing(ring)

  let xSum = 0
  let ySum = 0
  for (const [lng, lat] of unwrapped) {
    const [x, y] = toMercator(lng, lat)
    xSum += x
    // Clamp before summing — lat=±90 gives y=±Infinity (e.g. Antarctica)
    ySum += Math.max(-MAX_Y, Math.min(MAX_Y, y))
  }
  return [xSum / unwrapped.length, ySum / unwrapped.length]
}

export function repositionGeometry(
  geometry: Polygon | MultiPolygon,
  origCentroid: [number, number],
  newCentroid: [number, number],
  scale: number
): Polygon | MultiPolygon {
  if (geometry.type === 'Polygon') {
    return {
      type: 'Polygon',
      coordinates: geometry.coordinates.map((ring) =>
        repositionRing(ring, origCentroid, newCentroid, scale)
      ),
    }
  } else {
    return {
      type: 'MultiPolygon',
      coordinates: geometry.coordinates.map((part) =>
        part.map((ring) => repositionRing(ring, origCentroid, newCentroid, scale))
      ),
    }
  }
}

export function makeGhostFeatureCollection(
  geometry: Polygon | MultiPolygon,
  name: string
): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { name },
        geometry,
      },
    ],
  }
}

// Clips a ring against a single latitude half-plane using Sutherland-Hodgman.
// `inside(lat)` is true when the vertex is on the "keep" side.
// `intersect(a, b)` returns the point where edge a→b crosses the boundary.
function clipRingHalfPlane(
  ring: Position[],
  inside: (lat: number) => boolean,
  intersect: (a: Position, b: Position) => Position,
): Position[] | null {
  // Treat ring as closed: ignore duplicate last vertex if present
  const closed =
    ring.length > 1 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1]
  const n = closed ? ring.length - 1 : ring.length
  if (n < 3) return null

  const out: Position[] = []
  for (let i = 0; i < n; i++) {
    const cur = ring[i]
    const next = ring[(i + 1) % n]
    const ci = inside(cur[1])
    const ni = inside(next[1])
    if (ci) out.push(cur)
    if (ci !== ni) out.push(intersect(cur, next))
  }

  if (out.length < 3) return null
  // Re-close
  const f = out[0]
  const l = out[out.length - 1]
  if (f[0] !== l[0] || f[1] !== l[1]) out.push([f[0], f[1]])
  return out
}

// Clips a ring against both Mercator latitude limits using Sutherland-Hodgman.
// Correctly handles Antarctica's south-pole closure: instead of a diagonal
// shortcut (naive filter artifact), it inserts proper intersection vertices at
// ±MAX_LAT so the clipped ring has a clean horizontal edge at the boundary.
function clipRingToMercatorBounds(ring: Position[]): Position[] | null {
  // Clip south: keep lat >= -MAX_LAT
  const south = clipRingHalfPlane(
    ring,
    (lat) => lat >= -MAX_LAT,
    (a, b) => {
      const t = (-MAX_LAT - a[1]) / (b[1] - a[1])
      return [a[0] + t * (b[0] - a[0]), -MAX_LAT]
    },
  )
  if (!south) return null
  // Clip north: keep lat <= MAX_LAT
  return clipRingHalfPlane(
    south,
    (lat) => lat <= MAX_LAT,
    (a, b) => {
      const t = (MAX_LAT - a[1]) / (b[1] - a[1])
      return [a[0] + t * (b[0] - a[0]), MAX_LAT]
    },
  )
}

// Clips all rings in a geometry to Mercator bounds.
// Call this when loading geometry into the ghost lookup.
export function clipGeometryToMercatorBounds(
  geometry: Polygon | MultiPolygon,
): Polygon | MultiPolygon {
  const processRings = (rings: Position[][]): Position[][] | null => {
    const clipped = rings
      .map(clipRingToMercatorBounds)
      .filter((r): r is Position[] => r !== null)
    return clipped.length > 0 ? clipped : null
  }

  if (geometry.type === 'Polygon') {
    const rings = processRings(geometry.coordinates)
    return rings ? { type: 'Polygon', coordinates: rings } : geometry
  } else {
    const parts = geometry.coordinates
      .map((part) => processRings(part))
      .filter((p): p is Position[][] => p !== null)
    return parts.length > 0 ? { type: 'MultiPolygon', coordinates: parts } : geometry
  }
}

export const EMPTY_FEATURE_COLLECTION: FeatureCollection = {
  type: 'FeatureCollection',
  features: [],
}
