import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from 'maplibre-gl'
import type { ConjunctionEvent } from './orbitStream'
import type { SatPosition } from './satellites'
import { interpolateGreatCircle } from './greatCircle'

const ALTITUDE_SCALE = 1.0
const FLOATS_PER_VERTEX = 3 // mercX, mercY, altMeters
const BYTES_PER_VERTEX = FLOATS_PER_VERTEX * 4
// Tessellate the connecting line into a great-circle arc so distant pairs
// curve around the Earth instead of cutting a chord through it. 63 segments
// → 64 vertices is plenty for a smooth arc at any zoom we allow.
const SEGMENTS = 63
const VERTEX_CAPACITY = SEGMENTS + 1

const ATTRIB_POS = 0
const ATTRIB_ALT = 1

function buildVertexShader(prelude: string, define: string): string {
  return `#version 300 es
${prelude}
${define}
precision highp float;

in vec2 a_pos_merc;
in float a_alt_m;

uniform float u_altitude_scale;

void main() {
    gl_Position = projectTileFor3D(a_pos_merc, a_alt_m * u_altitude_scale);
}
`
}

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;

out vec4 fragColor;

void main() {
    // Bright red, fully opaque — selected pair only, so no time-fade or
    // selection-emphasis branching. The line "is" the focus by definition.
    fragColor = vec4(1.0, 0.20, 0.27, 1.0);
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

/**
 * 3D line layer that draws a single red segment between the two satellites of
 * the *currently selected* conjunction event. Endpoints are read from the
 * satellite stream's per-NORAD position cache, so the line tracks the live
 * orbital motion at 1 Hz.
 *
 * If either endpoint is unknown (no position batch yet for that NORAD), the
 * line is suppressed but the midpoint dot (a sibling layer) still renders —
 * the dot is anchored to event-embedded coords and never depends on a position
 * lookup.
 */
export class ConjunctionLineLayer implements CustomLayerInterface {
  readonly id = 'conjunctions-3d-line'
  readonly type = 'custom' as const
  readonly renderingMode = '3d' as const

  private map: MapLibreMap
  private gl: WebGL2RenderingContext | null = null
  private program: WebGLProgram | null = null
  private programVariantKey: string | null = null
  private vbo: WebGLBuffer | null = null
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
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo)
    gl.bufferData(gl.ARRAY_BUFFER, VERTEX_CAPACITY * BYTES_PER_VERTEX, gl.DYNAMIC_DRAW)
  }

  onRemove(_map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    if (!(gl instanceof WebGL2RenderingContext)) return
    if (this.program) gl.deleteProgram(this.program)
    if (this.vbo) gl.deleteBuffer(this.vbo)
    this.program = null
    this.programVariantKey = null
    this.vbo = null
    this.gl = null
    this.vertexCount = 0
  }

  /**
   * Update the layer to render the line for `event` (or clear it if `null`).
   * Endpoints come from `positions`; if either NORAD isn't in the cache yet,
   * the line is suppressed for this frame.
   */
  setData(event: ConjunctionEvent | null, positions: Map<number, SatPosition>): void {
    const gl = this.gl
    if (!gl || !this.vbo) {
      this.vertexCount = 0
      return
    }
    if (!event) {
      this.vertexCount = 0
      this.map.triggerRepaint()
      return
    }
    const a = positions.get(event.noradA)
    const b = positions.get(event.noradB)
    if (!a || !b) {
      this.vertexCount = 0
      this.map.triggerRepaint()
      return
    }
    // Great-circle path between the two sub-satellite points, with altitudes
    // linearly interpolated so the arc connects A's altitude → B's altitude.
    // Both endpoints are in space, so the curve never dips below ground.
    const points = interpolateGreatCircle([a.lng, a.lat], [b.lng, b.lat], SEGMENTS)
    const altA = a.altitudeKm
    const altB = b.altitudeKm
    const data = new Float32Array(points.length * FLOATS_PER_VERTEX)
    const last = points.length - 1 || 1
    for (let i = 0; i < points.length; i++) {
      const t = i / last
      const altMeters = (altA * (1 - t) + altB * t) * 1000
      const [lng, lat] = points[i]
      const [mx, my] = lngLatToMerc(lng, lat)
      data[i * FLOATS_PER_VERTEX + 0] = mx
      data[i * FLOATS_PER_VERTEX + 1] = my
      data[i * FLOATS_PER_VERTEX + 2] = altMeters
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data)
    this.vertexCount = points.length
    this.map.triggerRepaint()
  }

  render(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    args: CustomRenderMethodInput,
  ): void {
    if (!(gl instanceof WebGL2RenderingContext)) return
    if (this.vertexCount < 2 || !this.vbo) return

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

    gl.depthMask(false)
    gl.enable(gl.BLEND)
    gl.blendFuncSeparate(
      gl.SRC_ALPHA,
      gl.ONE_MINUS_SRC_ALPHA,
      gl.ONE,
      gl.ONE_MINUS_SRC_ALPHA,
    )

    gl.drawArrays(gl.LINE_STRIP, 0, this.vertexCount)

    gl.disableVertexAttribArray(ATTRIB_POS)
    gl.disableVertexAttribArray(ATTRIB_ALT)
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
