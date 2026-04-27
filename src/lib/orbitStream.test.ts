import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  decodePositionBatch,
  decodeConjunctionBatch,
  connectOrbitStream,
  MSG_POSITION_BATCH,
  MSG_CONJUNCTION_BATCH,
} from './orbitStream'

// ── Binary frame builders ─────────────────────────────────────────────────────
//
// PositionBatchMsg layout (little-endian, no padding):
//   offset  0: u64 tick_epoch_ms   (8 bytes)
//   offset  8: u64 count           (8 bytes)
//   offset 16: N × satellite record (15 bytes each)
//
// ConjunctionBatchMsg layout (same outer shape, 34-byte records):
//   offset  0: u64 generated_epoch_ms
//   offset  8: u64 count
//   offset 16: N × WireConjunction (34 bytes each)

interface SatRecord {
  norad: number
  lng: number
  lat: number
  altKm: number
  group: number
}

interface ConjRecord {
  noradA: number
  noradB: number
  tcaEpochMs: number
  missKm: number
  relVelKms: number
  groupA: number
  groupB: number
  midLat: number
  midLng: number
  midAltKm: number
}

function buildPositionPayload(records: SatRecord[], tickMs = 0): ArrayBuffer {
  const buf = new ArrayBuffer(16 + records.length * 15)
  const view = new DataView(buf)
  view.setUint32(0, tickMs & 0xffffffff, true)
  view.setUint32(4, 0, true)
  view.setUint32(8, records.length, true)
  view.setUint32(12, 0, true)
  let off = 16
  for (const r of records) {
    view.setUint32(off, r.norad, true)
    view.setFloat32(off + 4, r.lng, true)
    view.setFloat32(off + 8, r.lat, true)
    view.setUint16(off + 12, r.altKm, true)
    view.setUint8(off + 14, r.group)
    off += 15
  }
  return buf
}

function buildConjunctionPayload(records: ConjRecord[], generatedMs = 0): ArrayBuffer {
  const buf = new ArrayBuffer(16 + records.length * 38)
  const view = new DataView(buf)
  view.setUint32(0, generatedMs & 0xffffffff, true)
  view.setUint32(4, Math.floor(generatedMs / 0x1_0000_0000), true)
  view.setUint32(8, records.length, true)
  view.setUint32(12, 0, true)
  let off = 16
  for (const r of records) {
    view.setUint32(off, r.noradA, true)
    view.setUint32(off + 4, r.noradB, true)
    view.setUint32(off + 8, r.tcaEpochMs & 0xffffffff, true)
    view.setUint32(off + 12, Math.floor(r.tcaEpochMs / 0x1_0000_0000), true)
    view.setFloat32(off + 16, r.missKm, true)
    view.setFloat32(off + 20, r.relVelKms, true)
    view.setUint8(off + 24, r.groupA)
    view.setUint8(off + 25, r.groupB)
    view.setFloat32(off + 26, r.midLat, true)
    view.setFloat32(off + 30, r.midLng, true)
    view.setFloat32(off + 34, r.midAltKm, true)
    off += 38
  }
  return buf
}

/** Wrap a payload with a type-byte prefix to form a full wire frame. */
function withTypeByte(typeByte: number, payload: ArrayBuffer): ArrayBuffer {
  const out = new ArrayBuffer(1 + payload.byteLength)
  const view = new DataView(out)
  view.setUint8(0, typeByte)
  new Uint8Array(out, 1).set(new Uint8Array(payload))
  return out
}

const decodePos = (buf: ArrayBuffer) =>
  decodePositionBatch(new DataView(buf), 0, buf.byteLength)
const decodeConj = (buf: ArrayBuffer) =>
  decodeConjunctionBatch(new DataView(buf), 0, buf.byteLength)

// ── decodePositionBatch ───────────────────────────────────────────────────────

describe('decodePositionBatch', () => {
  it('returns [] for a buffer shorter than 16 bytes (header only)', () => {
    expect(decodePos(new ArrayBuffer(15))).toEqual([])
    expect(decodePos(new ArrayBuffer(0))).toEqual([])
  })

  it('returns [] for count=0', () => {
    const buf = buildPositionPayload([])
    expect(decodePos(buf)).toEqual([])
  })

  it('returns [] when buffer is truncated (count claims more records than fit)', () => {
    const buf = buildPositionPayload([{ norad: 1, lng: 0, lat: 0, altKm: 400, group: 0 }])
    const tampered = buf.slice(0)
    new DataView(tampered).setUint32(8, 3, true)
    expect(decodePos(tampered)).toEqual([])
  })

  it('decodes a single satellite record correctly', () => {
    const buf = buildPositionPayload([{ norad: 25544, lng: 45.5, lat: -12.3, altKm: 408, group: 0 }])
    const positions = decodePos(buf)
    expect(positions).toHaveLength(1)
    const p = positions[0]
    expect(p.norad).toBe(25544)
    expect(p.name).toBe('25544')
    expect(p.lng).toBeCloseTo(45.5, 2)
    expect(p.lat).toBeCloseTo(-12.3, 2)
    expect(p.altitudeKm).toBe(408)
    expect(p.group).toBe('iss')
  })

  it('decodes multiple satellite records in order', () => {
    const records: SatRecord[] = [
      { norad: 100, lng: 10, lat: 20, altKm: 500, group: 5 },
      { norad: 200, lng: -90, lat: 45, altKm: 20200, group: 2 },
      { norad: 300, lng: 170, lat: -60, altKm: 800, group: 4 },
    ]
    const positions = decodePos(buildPositionPayload(records))
    expect(positions).toHaveLength(3)
    expect(positions[0].norad).toBe(100)
    expect(positions[0].group).toBe('active')
    expect(positions[1].norad).toBe(200)
    expect(positions[1].group).toBe('gps')
    expect(positions[2].norad).toBe(300)
    expect(positions[2].group).toBe('debris')
  })

  it('maps all known group bytes correctly', () => {
    const groupMap: [number, string][] = [
      [0, 'iss'],
      [1, 'station'],
      [2, 'gps'],
      [3, 'geo'],
      [4, 'debris'],
      [5, 'active'],
    ]
    for (const [byte, name] of groupMap) {
      const buf = buildPositionPayload([{ norad: 1, lng: 0, lat: 0, altKm: 400, group: byte }])
      expect(decodePos(buf)[0].group).toBe(name)
    }
  })

  it('falls back to "active" for unknown group bytes', () => {
    const buf = buildPositionPayload([{ norad: 1, lng: 0, lat: 0, altKm: 400, group: 99 }])
    expect(decodePos(buf)[0].group).toBe('active')
  })

  it('handles large NORAD IDs (u32 max ~4.3B)', () => {
    const norad = 0x00_ff_ff_ff
    const buf = buildPositionPayload([{ norad, lng: 0, lat: 0, altKm: 0, group: 5 }])
    const p = decodePos(buf)[0]
    expect(p.norad).toBe(norad)
    expect(p.name).toBe(String(norad))
  })

  it('preserves longitude sign for negative values', () => {
    const buf = buildPositionPayload([{ norad: 1, lng: -120.7, lat: 35.2, altKm: 550, group: 5 }])
    const p = decodePos(buf)[0]
    expect(p.lng).toBeCloseTo(-120.7, 1)
    expect(p.lat).toBeCloseTo(35.2, 1)
  })

  it('respects offset+len so a typed view past a type byte still decodes', () => {
    const inner = buildPositionPayload([{ norad: 999, lng: 1, lat: 2, altKm: 300, group: 1 }])
    const wrapped = withTypeByte(MSG_POSITION_BATCH, inner)
    const view = new DataView(wrapped)
    const positions = decodePositionBatch(view, 1, wrapped.byteLength - 1)
    expect(positions).toHaveLength(1)
    expect(positions[0].norad).toBe(999)
    expect(positions[0].group).toBe('station')
  })
})

// ── decodeConjunctionBatch ────────────────────────────────────────────────────

describe('decodeConjunctionBatch', () => {
  it('returns [] for a buffer shorter than 16 bytes', () => {
    expect(decodeConj(new ArrayBuffer(15))).toEqual([])
    expect(decodeConj(new ArrayBuffer(0))).toEqual([])
  })

  it('returns [] for count=0', () => {
    const buf = buildConjunctionPayload([])
    expect(decodeConj(buf)).toEqual([])
  })

  it('returns [] when buffer is truncated', () => {
    const buf = buildConjunctionPayload([
      {
        noradA: 1, noradB: 2, tcaEpochMs: 0, missKm: 0, relVelKms: 0,
        groupA: 0, groupB: 0, midLat: 0, midLng: 0, midAltKm: 0,
      },
    ])
    const tampered = buf.slice(0)
    new DataView(tampered).setUint32(8, 5, true)
    expect(decodeConj(tampered)).toEqual([])
  })

  it('round-trips a single event with all fields preserved', () => {
    const records: ConjRecord[] = [
      {
        noradA: 25544, noradB: 48274,
        tcaEpochMs: 1_777_217_947_961,
        missKm: 3.2, relVelKms: 14.1,
        groupA: 0, groupB: 5, // iss ↔ active
        midLat: -12.345, midLng: 67.89, midAltKm: 412.5,
      },
    ]
    const buf = buildConjunctionPayload(records, 1_777_217_900_000)
    const events = decodeConj(buf)
    expect(events).toHaveLength(1)
    const e = events[0]
    expect(e.noradA).toBe(25544)
    expect(e.noradB).toBe(48274)
    expect(e.tcaEpochMs).toBe(1_777_217_947_961)
    expect(e.missKm).toBeCloseTo(3.2, 3)
    expect(e.relVelKms).toBeCloseTo(14.1, 3)
    expect(e.groupA).toBe('iss')
    expect(e.groupB).toBe('active')
    expect(e.midLat).toBeCloseTo(-12.345, 3)
    expect(e.midLng).toBeCloseTo(67.89, 3)
    expect(e.midAltKm).toBeCloseTo(412.5, 2)
  })

  it('decodes multiple events in order', () => {
    const records: ConjRecord[] = [
      {
        noradA: 1, noradB: 2, tcaEpochMs: 100, missKm: 1, relVelKms: 1,
        groupA: 2, groupB: 3, midLat: 10, midLng: 20, midAltKm: 800,
      },
      {
        noradA: 3, noradB: 4, tcaEpochMs: 200, missKm: 4.99, relVelKms: 8,
        groupA: 4, groupB: 5, midLat: -45, midLng: 110, midAltKm: 35786,
      },
    ]
    const events = decodeConj(buildConjunctionPayload(records))
    expect(events).toHaveLength(2)
    expect(events[0].noradA).toBe(1)
    expect(events[0].groupA).toBe('gps')
    expect(events[0].groupB).toBe('geo')
    expect(events[1].noradB).toBe(4)
    expect(events[1].groupA).toBe('debris')
    expect(events[1].groupB).toBe('active')
    expect(events[1].midLat).toBeCloseTo(-45, 3)
  })

  it('maps every group byte to a SatGroup string', () => {
    const groupMap: [number, string][] = [
      [0, 'iss'],
      [1, 'station'],
      [2, 'gps'],
      [3, 'geo'],
      [4, 'debris'],
      [5, 'active'],
    ]
    for (const [byte, name] of groupMap) {
      const buf = buildConjunctionPayload([
        {
          noradA: 1, noradB: 2, tcaEpochMs: 0, missKm: 0, relVelKms: 0,
          groupA: byte, groupB: byte, midLat: 0, midLng: 0, midAltKm: 0,
        },
      ])
      const e = decodeConj(buf)[0]
      expect(e.groupA).toBe(name)
      expect(e.groupB).toBe(name)
    }
  })

  it('falls back to "active" for unknown group bytes', () => {
    const buf = buildConjunctionPayload([
      {
        noradA: 1, noradB: 2, tcaEpochMs: 0, missKm: 0, relVelKms: 0,
        groupA: 99, groupB: 200, midLat: 0, midLng: 0, midAltKm: 0,
      },
    ])
    const e = decodeConj(buf)[0]
    expect(e.groupA).toBe('active')
    expect(e.groupB).toBe('active')
  })
})

// ── MockWebSocket ─────────────────────────────────────────────────────────────

type WsEventType = 'open' | 'message' | 'close' | 'error'

class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  readyState: number = MockWebSocket.CONNECTING
  binaryType: string = 'blob'
  url: string
  private listeners: Map<WsEventType, ((e: Event) => void)[]> = new Map()
  sentMessages: string[] = []

  constructor(url: string) {
    this.url = url
  }

  addEventListener(type: WsEventType, handler: (e: Event) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type)!.push(handler)
  }

  send(data: string) {
    this.sentMessages.push(data)
  }

  close() {
    this.readyState = MockWebSocket.CLOSED
  }

  simulateOpen() {
    this.readyState = MockWebSocket.OPEN
    this._emit('open', new Event('open'))
  }

  simulateMessage(data: ArrayBuffer | string) {
    const ev = Object.assign(new Event('message'), { data })
    this._emit('message', ev)
  }

  simulateClose() {
    this.readyState = MockWebSocket.CLOSED
    this._emit('close', new Event('close'))
  }

  simulateError() {
    this._emit('error', new Event('error'))
  }

  private _emit(type: WsEventType, ev: Event) {
    for (const h of this.listeners.get(type) ?? []) h(ev)
  }
}

// ── connectOrbitStream ────────────────────────────────────────────────────────

describe('connectOrbitStream', () => {
  let mockWs: MockWebSocket

  beforeEach(() => {
    mockWs = new MockWebSocket('wss://test')
    function WsStub(url: string) {
      mockWs.url = url
      return mockWs
    }
    WsStub.CONNECTING = 0
    WsStub.OPEN = 1
    WsStub.CLOSING = 2
    WsStub.CLOSED = 3
    vi.stubGlobal('WebSocket', WsStub)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('creates a WebSocket pointed at the provided URL', () => {
    connectOrbitStream('wss://example.com/stream', { onPositions: vi.fn() })
    expect(mockWs.url).toBe('wss://example.com/stream')
  })

  it('calls onConnect when the socket opens', () => {
    const onConnect = vi.fn()
    connectOrbitStream('wss://test', { onPositions: vi.fn(), onConnect })
    mockWs.simulateOpen()
    expect(onConnect).toHaveBeenCalledOnce()
  })

  it('calls onDisconnect when the socket closes', () => {
    const onDisconnect = vi.fn()
    connectOrbitStream('wss://test', { onPositions: vi.fn(), onDisconnect })
    mockWs.simulateClose()
    expect(onDisconnect).toHaveBeenCalledOnce()
  })

  it('calls onDisconnect when the socket errors', () => {
    const onDisconnect = vi.fn()
    connectOrbitStream('wss://test', { onPositions: vi.fn(), onDisconnect })
    mockWs.simulateError()
    expect(onDisconnect).toHaveBeenCalledOnce()
  })

  it('does NOT call onDisconnect after caller-initiated close()', () => {
    const onDisconnect = vi.fn()
    const handle = connectOrbitStream('wss://test', { onPositions: vi.fn(), onDisconnect })
    handle.close()
    mockWs.simulateClose()
    expect(onDisconnect).not.toHaveBeenCalled()
  })

  it('isLive() is true while connecting', () => {
    const handle = connectOrbitStream('wss://test', { onPositions: vi.fn() })
    expect(handle.isLive()).toBe(true)
  })

  it('isLive() is true when open', () => {
    const handle = connectOrbitStream('wss://test', { onPositions: vi.fn() })
    mockWs.simulateOpen()
    expect(handle.isLive()).toBe(true)
  })

  it('isLive() is false after close()', () => {
    const handle = connectOrbitStream('wss://test', { onPositions: vi.fn() })
    handle.close()
    expect(handle.isLive()).toBe(false)
  })

  it('routes 0x01 frames to onPositions', () => {
    const onPositions = vi.fn()
    const onConjunctions = vi.fn()
    connectOrbitStream('wss://test', { onPositions, onConjunctions })
    mockWs.simulateOpen()
    const inner = buildPositionPayload([{ norad: 25544, lng: 0, lat: 51, altKm: 408, group: 0 }])
    mockWs.simulateMessage(withTypeByte(MSG_POSITION_BATCH, inner))
    expect(onPositions).toHaveBeenCalledOnce()
    expect(onConjunctions).not.toHaveBeenCalled()
    const positions = onPositions.mock.calls[0][0]
    expect(positions[0].norad).toBe(25544)
  })

  it('routes 0x02 frames to onConjunctions', () => {
    const onPositions = vi.fn()
    const onConjunctions = vi.fn()
    connectOrbitStream('wss://test', { onPositions, onConjunctions })
    mockWs.simulateOpen()
    const inner = buildConjunctionPayload([
      {
        noradA: 1, noradB: 2, tcaEpochMs: 1234, missKm: 4.2, relVelKms: 9.1,
        groupA: 0, groupB: 5, midLat: -10, midLng: 30, midAltKm: 412,
      },
    ])
    mockWs.simulateMessage(withTypeByte(MSG_CONJUNCTION_BATCH, inner))
    expect(onPositions).not.toHaveBeenCalled()
    expect(onConjunctions).toHaveBeenCalledOnce()
    const events = onConjunctions.mock.calls[0][0]
    expect(events[0].noradA).toBe(1)
    expect(events[0].missKm).toBeCloseTo(4.2, 3)
    expect(events[0].midLat).toBeCloseTo(-10, 3)
  })

  it('silently ignores frames with an unknown type byte', () => {
    const onPositions = vi.fn()
    const onConjunctions = vi.fn()
    connectOrbitStream('wss://test', { onPositions, onConjunctions })
    mockWs.simulateOpen()
    const inner = buildPositionPayload([{ norad: 1, lng: 0, lat: 0, altKm: 0, group: 0 }])
    mockWs.simulateMessage(withTypeByte(0x99, inner))
    expect(onPositions).not.toHaveBeenCalled()
    expect(onConjunctions).not.toHaveBeenCalled()
  })

  it('does not invoke onConjunctions when no callback is registered', () => {
    const onPositions = vi.fn()
    connectOrbitStream('wss://test', { onPositions })
    mockWs.simulateOpen()
    const inner = buildConjunctionPayload([
      {
        noradA: 1, noradB: 2, tcaEpochMs: 0, missKm: 1, relVelKms: 1,
        groupA: 0, groupB: 0, midLat: 0, midLng: 0, midAltKm: 0,
      },
    ])
    // Should not throw even though onConjunctions is undefined.
    expect(() => mockWs.simulateMessage(withTypeByte(MSG_CONJUNCTION_BATCH, inner))).not.toThrow()
    expect(onPositions).not.toHaveBeenCalled()
  })

  it('ignores empty / non-ArrayBuffer messages', () => {
    const onPositions = vi.fn()
    connectOrbitStream('wss://test', { onPositions })
    mockWs.simulateOpen()
    mockWs.simulateMessage('plain text message')
    mockWs.simulateMessage(new ArrayBuffer(0))
    expect(onPositions).not.toHaveBeenCalled()
  })

  it('sends a viewport JSON string when updateViewport is called while open', () => {
    const handle = connectOrbitStream('wss://test', { onPositions: vi.fn() })
    mockWs.simulateOpen()
    handle.updateViewport({ west: -180, south: -90, east: 180, north: 90 })
    expect(mockWs.sentMessages).toHaveLength(1)
    const msg = JSON.parse(mockWs.sentMessages[0])
    expect(msg.west).toBe(-180)
    expect(msg.east).toBe(180)
    expect(msg.min_alt_km).toBe(0)
    expect(msg.max_alt_km).toBe(65_000)
  })

  it('uses provided minAltKm / maxAltKm in the viewport message', () => {
    const handle = connectOrbitStream('wss://test', { onPositions: vi.fn() })
    mockWs.simulateOpen()
    handle.updateViewport({ west: 0, south: 0, east: 1, north: 1, minAltKm: 200, maxAltKm: 1000 })
    const msg = JSON.parse(mockWs.sentMessages[0])
    expect(msg.min_alt_km).toBe(200)
    expect(msg.max_alt_km).toBe(1000)
  })

  it('queues a viewport update called before open and sends it on connect', () => {
    const handle = connectOrbitStream('wss://test', { onPositions: vi.fn() })
    handle.updateViewport({ west: -10, south: -10, east: 10, north: 10 })
    expect(mockWs.sentMessages).toHaveLength(0)
    mockWs.simulateOpen()
    expect(mockWs.sentMessages).toHaveLength(1)
    const msg = JSON.parse(mockWs.sentMessages[0])
    expect(msg.west).toBe(-10)
  })
})
