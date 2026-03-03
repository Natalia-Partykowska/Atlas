import type { Polygon, MultiPolygon, Position, FeatureCollection } from 'geojson'

const MAX_LAT = 85.051129

function wrapLng(lng: number): number {
  return ((lng % 360) + 540) % 360 - 180
}

function translateRing(ring: Position[], dLng: number, dLat: number): Position[] {
  return ring.map(([lng, lat, ...rest]) => [
    wrapLng(lng + dLng),
    Math.max(-MAX_LAT, Math.min(MAX_LAT, lat + dLat)),
    ...rest,
  ])
}

export function computeCentroid(geometry: Polygon | MultiPolygon): [number, number] {
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

  const lngSum = ring.reduce((s, c) => s + c[0], 0)
  const latSum = ring.reduce((s, c) => s + c[1], 0)
  return [lngSum / ring.length, latSum / ring.length]
}

export function translateGeometry(
  geometry: Polygon | MultiPolygon,
  dLng: number,
  dLat: number
): Polygon | MultiPolygon {
  if (geometry.type === 'Polygon') {
    return {
      type: 'Polygon',
      coordinates: geometry.coordinates.map((ring) => translateRing(ring, dLng, dLat)),
    }
  } else {
    return {
      type: 'MultiPolygon',
      coordinates: geometry.coordinates.map((part) =>
        part.map((ring) => translateRing(ring, dLng, dLat))
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
