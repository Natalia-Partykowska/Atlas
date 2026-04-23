import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { decodeBatch, connectOrbitStream } from './orbitStream'

// ── Binary frame builder ──────────────────────────────────────────────────────
//
// PositionBatchMsg layout (little-endian, no padding):
//   offset  0: u64  tick_epoch_ms   (8 bytes)
//   offset  8: u64  count           (8 bytes)
//   offset 16: N × satellite record (15 bytes each)
//     +0  u32 norad
//     +4  f32 lng
//     +8  f32 lat
//     +12 u16 altKm
//     +14 u8  group

interface SatRecord {
  norad: number
  lng: number
  lat: number
  altKm: number
  group: number
}

function buildFrame(records: SatRecord[], tickMs = 0): ArrayBuffer {
  const buf = new ArrayBuffer(16 + records.length * 15)
  const view = new DataView(buf)
  // tick_epoch_ms (u64 as two u32)
  view.setUint32(0, tickMs & 0xffffffff, true)
  view.setUint32(4, 0, true)
  // count (u64 as two u32)
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

// ── decodeBatch ───────────────────────────────────────────────────────────────

describe('decodeBatch', () => {
  it('returns [] for a buffer shorter than 16 bytes (header only)', () => {
    expect(decodeBatch(new ArrayBuffer(15))).toEqual([])
    expect(decodeBatch(new ArrayBuffer(0))).toEqual([])
  })

  it('returns [] for count=0', () => {
    const buf = buildFrame([])
    expect(decodeBatch(buf)).toEqual([])
  })

  it('returns [] when buffer is truncated (count claims more records than fit)', () => {
    // Header says count=3 but we only have space for 1 record
    const buf = buildFrame([{ norad: 1, lng: 0, lat: 0, altKm: 400, group: 0 }])
    // Lie about count in a copy of the buffer
    const tampered = buf.slice(0)
    new DataView(tampered).setUint32(8, 3, true) // claim 3 records
    expect(decodeBatch(tampered)).toEqual([])
  })

  it('decodes a single satellite record correctly', () => {
    const buf = buildFrame([{ norad: 25544, lng: 45.5, lat: -12.3, altKm: 408, group: 0 }])
    const positions = decodeBatch(buf)
    expect(positions).toHaveLength(1)
    const p = positions[0]
    expect(p.name).toBe('25544')
    expect(p.lng).toBeCloseTo(45.5, 2)
    expect(p.lat).toBeCloseTo(-12.3, 2)
    expect(p.altitudeKm).toBe(408)
    expect(p.group).toBe('iss') // group 0 → iss
  })

  it('decodes multiple satellite records in order', () => {
    const records: SatRecord[] = [
      { norad: 100, lng: 10, lat: 20, altKm: 500, group: 5 }, // active
      { norad: 200, lng: -90, lat: 45, altKm: 20200, group: 2 }, // gps
      { norad: 300, lng: 170, lat: -60, altKm: 800, group: 4 }, // debris
    ]
    const positions = decodeBatch(buildFrame(records))
    expect(positions).toHaveLength(3)
    expect(positions[0].name).toBe('100')
    expect(positions[0].group).toBe('active')
    expect(positions[1].name).toBe('200')
    expect(positions[1].group).toBe('gps')
    expect(positions[2].name).toBe('300')
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
      const buf = buildFrame([{ norad: 1, lng: 0, lat: 0, altKm: 400, group: byte }])
      expect(decodeBatch(buf)[0].group).toBe(name)
    }
  })

  it('falls back to "active" for unknown group bytes', () => {
    const buf = buildFrame([{ norad: 1, lng: 0, lat: 0, altKm: 400, group: 99 }])
    expect(decodeBatch(buf)[0].group).toBe('active')
  })

  it('handles large NORAD IDs (u32 max ~4.3B)', () => {
    const norad = 0x00_ff_ff_ff // 16,777,215
    const buf = buildFrame([{ norad, lng: 0, lat: 0, altKm: 0, group: 5 }])
    expect(decodeBatch(buf)[0].name).toBe(String(norad))
  })

  it('preserves longitude sign for negative values', () => {
    const buf = buildFrame([{ norad: 1, lng: -120.7, lat: 35.2, altKm: 550, group: 5 }])
    const p = decodeBatch(buf)[0]
    expect(p.lng).toBeCloseTo(-120.7, 1)
    expect(p.lat).toBeCloseTo(35.2, 1)
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

  // Test helpers to simulate server-side events
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
    // Regular function (not arrow) so `new` works; returning an object from a
    // constructor makes `new` yield that object — we reuse the pre-built instance.
    function WsStub(url: string) {
      mockWs.url = url
      return mockWs
    }
    WsStub.CONNECTING = 0
    WsStub.OPEN      = 1
    WsStub.CLOSING   = 2
    WsStub.CLOSED    = 3
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
    // readyState is CONNECTING (0) by default
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

  it('calls onPositions with decoded positions on binary messages', () => {
    const onPositions = vi.fn()
    connectOrbitStream('wss://test', { onPositions })
    mockWs.simulateOpen()
    const buf = buildFrame([{ norad: 25544, lng: 0, lat: 51, altKm: 408, group: 0 }])
    mockWs.simulateMessage(buf)
    expect(onPositions).toHaveBeenCalledOnce()
    const [positions] = onPositions.mock.calls[0]
    expect(positions).toHaveLength(1)
    expect(positions[0].name).toBe('25544')
  })

  it('ignores non-ArrayBuffer messages', () => {
    const onPositions = vi.fn()
    connectOrbitStream('wss://test', { onPositions })
    mockWs.simulateOpen()
    mockWs.simulateMessage('plain text message')
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
    // Called before open — socket is still CONNECTING
    handle.updateViewport({ west: -10, south: -10, east: 10, north: 10 })
    expect(mockWs.sentMessages).toHaveLength(0) // not sent yet
    mockWs.simulateOpen()
    expect(mockWs.sentMessages).toHaveLength(1) // flushed on open
    const msg = JSON.parse(mockWs.sentMessages[0])
    expect(msg.west).toBe(-10)
  })
})
