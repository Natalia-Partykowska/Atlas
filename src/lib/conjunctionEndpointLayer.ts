import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from 'maplibre-gl'
import type { ConjunctionEvent } from './orbitStream'
import type { SatPosition } from './satellites'

const ALTITUDE_SCALE = 1.0
const FLOATS_PER_VERTEX = 3 // mercX, mercY, altMeters
const BYTES_PER_VERTEX = FLOATS_PER_VERTEX * 4
const VERTEX_CAPACITY = 2 // exactly two endpoints: A and B
const RING_RADIUS_PX = 9 // generous so the halo reads against the satellite swarm

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
uniform float u_dot_radius;
uniform float u_pixel_ratio;

void main() {
    gl_Position = projectTileFor3D(a_pos_merc, a_alt_m * u_altitude_scale);
    gl_PointSize = u_dot_radius * 2.5 * u_pixel_ratio;
}
`
}

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;

out vec4 fragColor;

void main() {
    // Translucent red halo ring — sits around the live satellite dot drawn
    // by the satellite layer, so the user can pick the selected pair out of
    // the swarm. The ring is hollow: the satellite's own colour shows through
    // the centre.
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = length(d) * 2.0;
    if (r > 1.0) discard;

    // Inner edge (rises) × outer edge (falls) → a ring at r ≈ 0.65–0.90.
    float inner = smoothstep(0.55, 0.65, r);
    float outer = 1.0 - smoothstep(0.88, 0.96, r);
    float ring = inner * outer;
    if (ring < 0.02) discard;

    fragColor = vec4(1.0, 0.30, 0.35, ring * 0.95);
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
    console.error('[ConjunctionEndpointLayer] shader compile failed:', gl.getShaderInfoLog(sh))
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
 * Halo-ring layer that marks the *current* positions of the two satellites
 * in the selected conjunction pair. Endpoints come from the per-NORAD live
 * position cache (refreshed each 1 Hz position batch); if either NORAD
 * hasn't been seen yet the layer renders nothing for that frame and waits
 * for the next batch.
 */
export class ConjunctionEndpointLayer implements CustomLayerInterface {
  readonly id = 'conjunctions-3d-endpoints'
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
  private uDotRadius: WebGLUniformLocation | null = null
  private uPixelRatio: WebGLUniformLocation | null = null

  constructor(map: MapLibreMap) {
    this.map = map
  }

  onAdd(_map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    if (!(gl instanceof WebGL2RenderingContext)) {
      console.warn('[ConjunctionEndpointLayer] WebGL2 context required; layer disabled')
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
    const [ax, ay] = lngLatToMerc(a.lng, a.lat)
    const [bx, by] = lngLatToMerc(b.lng, b.lat)
    const data = new Float32Array([
      ax, ay, a.altitudeKm * 1000,
      bx, by, b.altitudeKm * 1000,
    ])
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data)
    this.vertexCount = 2
    this.map.triggerRepaint()
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
    if (this.uDotRadius) gl.uniform1f(this.uDotRadius, RING_RADIUS_PX)
    if (this.uPixelRatio)
      gl.uniform1f(this.uPixelRatio, window.devicePixelRatio || 1)

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

    gl.drawArrays(gl.POINTS, 0, this.vertexCount)

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
        '[ConjunctionEndpointLayer] link failed:',
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
    this.uDotRadius = gl.getUniformLocation(program, 'u_dot_radius')
    this.uPixelRatio = gl.getUniformLocation(program, 'u_pixel_ratio')
  }
}
