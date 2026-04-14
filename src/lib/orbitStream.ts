import type { SatGroup, SatPosition } from './satellites'

export interface ViewportBounds {
  west: number
  south: number
  east: number
  north: number
  minAltKm?: number
  maxAltKm?: number
}

export interface OrbitStreamHandle {
  updateViewport: (bounds: ViewportBounds) => void
  close: () => void
}

export interface OrbitStreamCallbacks {
  onPositions: (positions: SatPosition[]) => void
  onConnect?: () => void
  onDisconnect?: () => void
}

// Must match `Group::as_u8()` in server/src/catalog.rs
const GROUP_BY_U8: Record<number, SatGroup> = {
  0: 'iss',
  1: 'station',
  2: 'gps',
  3: 'geo',
  4: 'debris',
  5: 'active',
}

/**
 * Decode a bincode-serialized `PositionBatchMsg`:
 *   u64 tick_epoch_ms | u64 vec_len | N × (u32 norad, f32 lng, f32 lat, u16 alt, u8 group)
 * All little-endian, no padding, fixint encoding (bincode default).
 */
function decodeBatch(buf: ArrayBuffer): SatPosition[] {
  const view = new DataView(buf)
  if (buf.byteLength < 16) return []
  // Skip tick_epoch_ms at offset 0 (not needed by client yet).
  const countLo = view.getUint32(8, true)
  const countHi = view.getUint32(12, true)
  // Counts fit safely in a JS number for any realistic catalog size.
  const count = countHi * 0x1_0000_0000 + countLo
  const expected = 16 + count * 15
  if (buf.byteLength < expected) return []

  const positions: SatPosition[] = new Array(count)
  let off = 16
  for (let i = 0; i < count; i++) {
    const norad = view.getUint32(off, true)
    const lng = view.getFloat32(off + 4, true)
    const lat = view.getFloat32(off + 8, true)
    const alt = view.getUint16(off + 12, true)
    const groupU8 = view.getUint8(off + 14)
    off += 15
    positions[i] = {
      name: String(norad),
      group: GROUP_BY_U8[groupU8] ?? 'active',
      lng,
      lat,
      altitudeKm: alt,
    }
  }
  return positions
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
    if (!(ev.data instanceof ArrayBuffer)) return
    const positions = decodeBatch(ev.data)
    cbs.onPositions(positions)
  })

  const handleEnd = () => {
    if (closedByCaller) return
    cbs.onDisconnect?.()
  }
  ws.addEventListener('close', handleEnd)
  ws.addEventListener('error', handleEnd)

  return {
    updateViewport: sendViewport,
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
