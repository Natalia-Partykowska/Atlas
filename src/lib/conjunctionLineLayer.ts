import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from 'maplibre-gl'
import type { ConjunctionEvent } from './orbitStream'
import type { SatPosition } from './satellites'

const ALTITUDE_SCALE = 1.0
const INITIAL_CAPACITY = 1024 // vertices (i.e. 512 events)
const FLOATS_PER_VERTEX = 5 // mercX, mercY, altMeters, opacity, selected
const BYTES_PER_VERTEX = FLOATS_PER_VERTEX * 4
const FORECAST_WINDOW_MS = 7_200_000 // 2 h

const ATTRIB_POS = 0
const ATTRIB_ALT = 1
const ATTRIB_OPACITY = 2
const ATTRIB_SELECTED = 3

function buildVertexShader(prelude: string, define: string): string {
  return `#version 300 es
${prelude}
${define}
precision highp float;

in vec2 a_pos_merc;
in float a_alt_m;
in float a_opacity;
in float a_selected;

uniform float u_altitude_scale;

out float v_opacity;
out float v_selected;

void main() {
    v_opacity = a_opacity;
    v_selected = a_selected;
    gl_Position = projectTileFor3D(a_pos_merc, a_alt_m * u_altitude_scale);
}
`
}

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;

in float v_opacity;
in float v_selected;
out vec4 fragColor;

void main() {
    // Red conjunction colour (matches the dot fill on the surface).
    vec3 base = vec3(1.0, 0.20, 0.27);
    float dim = v_selected > 0.5 ? 1.0 : 0.6;
    float a = clamp(v_opacity * dim, 0.0, 1.0);
    if (a < 0.01) discard;
    fragColor = vec4(base, a);
}
`

function compileShader(
  gl: WebGL2RenderingContext,
  type: GLenum,
  src: string,
): WebGLShader | null {
  const sh = gl.createShader(type)
  if (!sh) return null
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error('[ConjunctionLineLayer] shader compile failed:', gl.getShaderInfoLog(sh))
    console.error(src)
    gl.deleteShader(sh)
    return null
  }
  return sh
}

function lngLatToMerc(lng: number, lat: number): [number, number] {
  const x = (lng + 180) / 360
  const sinLat = Math.sin((lat * Math.PI) / 180)
  const y = 0.5 - (0.25 * Math.log((1 + sinLat) / (1 - sinLat))) / Math.PI
  return [x, y]
}

export class ConjunctionLineLayer implements CustomLayerInterface {
  readonly id = 'conjunctions-3d-line'
  readonly type = 'custom' as const
  readonly renderingMode = '3d' as const

  private map: MapLibreMap
  private gl: WebGL2RenderingContext | null = null
  private program: WebGLProgram | null = null
  private programVariantKey: string | null = null
  private vbo: WebGLBuffer | null = null
  private capacity = 0
  private vertexCount = 0

  private uPosMatrix: WebGLUniformLocation | null = null
  private uTileMerc: WebGLUniformLocation | null = null
  private uClipping: WebGLUniformLocation | null = null
  private uTransition: WebGLUniformLocation | null = null
  private uFallback: WebGLUniformLocation | null = null
  private uAltScale: WebGLUniformLocation | null = null

  constructor(map: MapLibreMap) {
    this.map = map
  }

  onAdd(_map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    if (!(gl instanceof WebGL2RenderingContext)) {
      console.warn('[ConjunctionLineLayer] WebGL2 context required; layer disabled')
      return
    }
    this.gl = gl
    this.vbo = gl.createBuffer()
    this.allocate(INITIAL_CAPACITY)
  }

  onRemove(_map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    if (!(gl instanceof WebGL2RenderingContext)) return
    if (this.program) gl.deleteProgram(this.program)
    if (this.vbo) gl.deleteBuffer(this.vbo)
    this.program = null
    this.programVariantKey = null
    this.vbo = null
    this.gl = null
    this.capacity = 0
    this.vertexCount = 0
  }

  /**
   * Replace the buffer with one line segment per event whose endpoints are
   * known. Events whose A or B isn't yet in `positions` are silently skipped —
   * the corresponding dot on the surface (drawn by the GeoJSON layer) still
   * anchors the event.
   */
  setData(
    events: ConjunctionEvent[],
    positions: Map<number, SatPosition>,
    selectedKey: string | null,
    nowMs: number,
  ): void {
    const gl = this.gl
    if (!gl || !this.vbo) {
      this.vertexCount = 0
      return
    }

    // Pack into a Float32Array — 2 vertices per renderable event.
    const tmp = new Float32Array(events.length * 2 * FLOATS_PER_VERTEX)
    let v = 0
    for (const e of events) {
      const a = positions.get(e.noradA)
      const b = positions.get(e.noradB)
      if (!a || !b) continue
      const [ax, ay] = lngLatToMerc(a.lng, a.lat)
      const [bx, by] = lngLatToMerc(b.lng, b.lat)
      const aAlt = a.altitudeKm * 1000
      const bAlt = b.altitudeKm * 1000
      const opacity = Math.max(
        0.25,
        Math.min(1.0, 1.0 - (e.tcaEpochMs - nowMs) / FORECAST_WINDOW_MS),
      )
      const key = `${e.noradA}-${e.noradB}`
      const selected = selectedKey === key ? 1.0 : 0.0
      // Vertex A
      tmp[v++] = ax
      tmp[v++] = ay
      tmp[v++] = aAlt
      tmp[v++] = opacity
      tmp[v++] = selected
      // Vertex B
      tmp[v++] = bx
      tmp[v++] = by
      tmp[v++] = bAlt
      tmp[v++] = opacity
      tmp[v++] = selected
    }
    const vertexCount = v / FLOATS_PER_VERTEX
    if (vertexCount > this.capacity) {
      this.allocate(Math.max(vertexCount, this.capacity * 2))
    }
    if (vertexCount > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, tmp, 0, vertexCount * FLOATS_PER_VERTEX)
    }
    this.vertexCount = vertexCount
    this.map.triggerRepaint()
  }

  clear(): void {
    if (this.vertexCount === 0) return
    this.vertexCount = 0
    this.map.triggerRepaint()
  }

  private allocate(capacity: number): void {
    const gl = this.gl
    if (!gl || !this.vbo) return
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo)
    gl.bufferData(gl.ARRAY_BUFFER, capacity * BYTES_PER_VERTEX, gl.DYNAMIC_DRAW)
    this.capacity = capacity
  }

  render(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    args: CustomRenderMethodInput,
  ): void {
    if (!(gl instanceof WebGL2RenderingContext)) return
    if (this.vertexCount === 0 || !this.vbo) return

    const variant = args.shaderData.variantName
    if (!this.program || this.programVariantKey !== variant) {
      this.compile(gl, args.shaderData.vertexShaderPrelude, args.shaderData.define)
      this.programVariantKey = variant
    }
    if (!this.program) return

    gl.useProgram(this.program)

    const pd = args.defaultProjectionData
    if (this.uPosMatrix)
      gl.uniformMatrix4fv(this.uPosMatrix, false, pd.mainMatrix as Float32List)
    if (this.uTileMerc) gl.uniform4fv(this.uTileMerc, pd.tileMercatorCoords)
    if (this.uClipping) gl.uniform4fv(this.uClipping, pd.clippingPlane)
    if (this.uTransition) gl.uniform1f(this.uTransition, pd.projectionTransition)
    if (this.uFallback)
      gl.uniformMatrix4fv(this.uFallback, false, pd.fallbackMatrix as Float32List)
    if (this.uAltScale) gl.uniform1f(this.uAltScale, ALTITUDE_SCALE)

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo)
    gl.enableVertexAttribArray(ATTRIB_POS)
    gl.vertexAttribPointer(ATTRIB_POS, 2, gl.FLOAT, false, BYTES_PER_VERTEX, 0)
    gl.enableVertexAttribArray(ATTRIB_ALT)
    gl.vertexAttribPointer(ATTRIB_ALT, 1, gl.FLOAT, false, BYTES_PER_VERTEX, 8)
    gl.enableVertexAttribArray(ATTRIB_OPACITY)
    gl.vertexAttribPointer(ATTRIB_OPACITY, 1, gl.FLOAT, false, BYTES_PER_VERTEX, 12)
    gl.enableVertexAttribArray(ATTRIB_SELECTED)
    gl.vertexAttribPointer(ATTRIB_SELECTED, 1, gl.FLOAT, false, BYTES_PER_VERTEX, 16)

    gl.depthMask(false)
    gl.enable(gl.BLEND)
    gl.blendFuncSeparate(
      gl.SRC_ALPHA,
      gl.ONE_MINUS_SRC_ALPHA,
      gl.ONE,
      gl.ONE_MINUS_SRC_ALPHA,
    )

    gl.drawArrays(gl.LINES, 0, this.vertexCount)

    gl.disableVertexAttribArray(ATTRIB_POS)
    gl.disableVertexAttribArray(ATTRIB_ALT)
    gl.disableVertexAttribArray(ATTRIB_OPACITY)
    gl.disableVertexAttribArray(ATTRIB_SELECTED)
  }

  private compile(
    gl: WebGL2RenderingContext,
    prelude: string,
    define: string,
  ): void {
    if (this.program) {
      gl.deleteProgram(this.program)
      this.program = null
    }
    const vs = compileShader(gl, gl.VERTEX_SHADER, buildVertexShader(prelude, define))
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER)
    if (!vs || !fs) return

    const program = gl.createProgram()
    if (!program) {
      gl.deleteShader(vs)
      gl.deleteShader(fs)
      return
    }
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.bindAttribLocation(program, ATTRIB_POS, 'a_pos_merc')
    gl.bindAttribLocation(program, ATTRIB_ALT, 'a_alt_m')
    gl.bindAttribLocation(program, ATTRIB_OPACITY, 'a_opacity')
    gl.bindAttribLocation(program, ATTRIB_SELECTED, 'a_selected')
    gl.linkProgram(program)
    gl.deleteShader(vs)
    gl.deleteShader(fs)

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error(
        '[ConjunctionLineLayer] link failed:',
        gl.getProgramInfoLog(program),
      )
      gl.deleteProgram(program)
      return
    }

    this.program = program
    this.uPosMatrix = gl.getUniformLocation(program, 'u_projection_matrix')
    this.uTileMerc = gl.getUniformLocation(program, 'u_projection_tile_mercator_coords')
    this.uClipping = gl.getUniformLocation(program, 'u_projection_clipping_plane')
    this.uTransition = gl.getUniformLocation(program, 'u_projection_transition')
    this.uFallback = gl.getUniformLocation(program, 'u_projection_fallback_matrix')
    this.uAltScale = gl.getUniformLocation(program, 'u_altitude_scale')
  }
}
