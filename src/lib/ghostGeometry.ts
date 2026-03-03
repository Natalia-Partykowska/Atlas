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

function wrapX(x: number): number {
  return ((x % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI
}

function repositionRing(
  ring: Position[],
  origCentroid: [number, number],
  newCentroid: [number, number],
  scale: number
): Position[] {
  return ring.map(([lng, lat, ...rest]) => {
    const [x, y] = toMercator(lng, lat)
    const nx = wrapX(newCentroid[0] + (x - origCentroid[0]) * scale)
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

  let xSum = 0
  let ySum = 0
  for (const [lng, lat] of ring) {
    const [x, y] = toMercator(lng, lat)
    xSum += x
    ySum += y
  }
  return [xSum / ring.length, ySum / ring.length]
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

export const EMPTY_FEATURE_COLLECTION: FeatureCollection = {
  type: 'FeatureCollection',
  features: [],
}
