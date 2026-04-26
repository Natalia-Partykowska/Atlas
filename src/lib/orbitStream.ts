import type { SatGroup, SatPosition } from './satellites'

export interface ViewportBounds {
  west: number
  south: number
  east: number
  north: number
  minAltKm?: number
  maxAltKm?: number
}

export interface ConjunctionEvent {
  noradA: number
  noradB: number
  tcaEpochMs: number
  missKm: number
  relVelKms: number
  groupA: SatGroup
  groupB: SatGroup
  midLat: number
  midLng: number
}

export interface OrbitStreamHandle {
  updateViewport: (bounds: ViewportBounds) => void
  isLive: () => boolean
  close: () => void
}

export interface OrbitStreamCallbacks {
  onPositions: (positions: SatPosition[]) => void
  onConjunctions?: (events: ConjunctionEvent[]) => void
  onConnect?: () => void
  onDisconnect?: () => void
}

// Wire-format type bytes — must match server/src/protocol.rs.
export const MSG_POSITION_BATCH = 0x01
export const MSG_CONJUNCTION_BATCH = 0x02

// Must match `Group::as_u8()` in server/src/catalog.rs
const GROUP_BY_U8: Record<number, SatGroup> = {
  0: 'iss',
  1: 'station',
  2: 'gps',
  3: 'geo',
  4: 'debris',
  5: 'active',
}

// JS Numbers safely represent integers up to 2^53 — TCA epochs and tick
// timestamps fit comfortably even though they're encoded as u64.
function readU64LE(view: DataView, offset: number): number {
  const lo = view.getUint32(offset, true)
  const hi = view.getUint32(offset + 4, true)
  return hi * 0x1_0000_0000 + lo
}

/**
 * Decode a bincode-serialized `PositionBatchMsg`:
 *   u64 tick_epoch_ms | u64 vec_len | N × (u32 norad, f32 lng, f32 lat, u16 alt, u8 group)
 * All little-endian, no padding, fixint encoding (bincode default).
 *
 * Pure: takes the underlying `DataView` plus the byte slice it owns. Caller
 * positions past the type byte before calling.
 */
export function decodePositionBatch(
  view: DataView,
  offset: number,
  len: number,
): SatPosition[] {
  if (len < 16) return []
  // Skip tick_epoch_ms at offset (not needed by client yet).
  const count = readU64LE(view, offset + 8)
  const expected = 16 + count * 15
  if (len < expected) return []

  const positions: SatPosition[] = new Array(count)
  let off = offset + 16
  for (let i = 0; i < count; i++) {
    const norad = view.getUint32(off, true)
    const lng = view.getFloat32(off + 4, true)
    const lat = view.getFloat32(off + 8, true)
    const alt = view.getUint16(off + 12, true)
    const groupU8 = view.getUint8(off + 14)
    off += 15
    positions[i] = {
      norad,
      name: String(norad),
      group: GROUP_BY_U8[groupU8] ?? 'active',
      lng,
      lat,
      altitudeKm: alt,
    }
  }
  return positions
}

/**
 * Decode a bincode-serialized `ConjunctionBatchMsg`:
 *   u64 generated_epoch_ms | u64 vec_len | N × WireConjunction
 *
 * WireConjunction layout (34 bytes, little-endian, no padding):
 *   +0  u32 norad_a
 *   +4  u32 norad_b
 *   +8  u64 tca_epoch_ms
 *  +16  f32 miss_km
 *  +20  f32 rel_vel_kms
 *  +24  u8  group_a
 *  +25  u8  group_b
 *  +26  f32 mid_lat
 *  +30  f32 mid_lng
 */
export function decodeConjunctionBatch(
  view: DataView,
  offset: number,
  len: number,
): ConjunctionEvent[] {
  if (len < 16) return []
  const count = readU64LE(view, offset + 8)
  const recordSize = 34
  const expected = 16 + count * recordSize
  if (len < expected) return []

  const events: ConjunctionEvent[] = new Array(count)
  let off = offset + 16
  for (let i = 0; i < count; i++) {
    const noradA = view.getUint32(off, true)
    const noradB = view.getUint32(off + 4, true)
    const tcaEpochMs = readU64LE(view, off + 8)
    const missKm = view.getFloat32(off + 16, true)
    const relVelKms = view.getFloat32(off + 20, true)
    const groupA = GROUP_BY_U8[view.getUint8(off + 24)] ?? 'active'
    const groupB = GROUP_BY_U8[view.getUint8(off + 25)] ?? 'active'
    const midLat = view.getFloat32(off + 26, true)
    const midLng = view.getFloat32(off + 30, true)
    off += recordSize
    events[i] = {
      noradA,
      noradB,
      tcaEpochMs,
      missKm,
      relVelKms,
      groupA,
      groupB,
      midLat,
      midLng,
    }
  }
  return events
}

export function connectOrbitStream(
  url: string,
  cbs: OrbitStreamCallbacks,
): OrbitStreamHandle {
  let ws: WebSocket | null = new WebSocket(url)
  ws.binaryType = 'arraybuffer'

  let pendingViewport: ViewportBounds | null = null
  let closedByCaller = false

  const sendViewport = (v: ViewportBounds) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      pendingViewport = v
      return
    }
    ws.send(
      JSON.stringify({
        west: v.west,
        south: v.south,
        east: v.east,
        north: v.north,
        min_alt_km: v.minAltKm ?? 0,
        max_alt_km: v.maxAltKm ?? 65_000,
      }),
    )
  }

  ws.addEventListener('open', () => {
    cbs.onConnect?.()
    if (pendingViewport) {
      sendViewport(pendingViewport)
      pendingViewport = null
    }
  })

  ws.addEventListener('message', (ev) => {
    if (!(ev.data instanceof ArrayBuffer) || ev.data.byteLength < 1) return
    const view = new DataView(ev.data)
    const msgType = view.getUint8(0)
    const payloadLen = ev.data.byteLength - 1
    switch (msgType) {
      case MSG_POSITION_BATCH:
        cbs.onPositions(decodePositionBatch(view, 1, payloadLen))
        break
      case MSG_CONJUNCTION_BATCH:
        cbs.onConjunctions?.(decodeConjunctionBatch(view, 1, payloadLen))
        break
      default:
        // Forward-compat: silently ignore unknown frame types.
        break
    }
  })

  const handleEnd = () => {
    if (closedByCaller) return
    cbs.onDisconnect?.()
  }
  ws.addEventListener('close', handleEnd)
  ws.addEventListener('error', handleEnd)

  return {
    updateViewport: sendViewport,
    isLive: () =>
      ws !== null &&
      (ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING),
    close: () => {
      closedByCaller = true
      if (ws) {
        try {
          ws.close()
        } catch {
          // ignore
        }
        ws = null
      }
    },
  }
}
