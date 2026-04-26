import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from 'maplibre-gl'
import { GROUP_INDEX, SATELLITE_GROUPS } from './satellites'
import type { SatGroup } from './satellites'

const ALTITUDE_SCALE = 1.0
const INITIAL_CAPACITY = 32_768
const POS_FLOATS_PER_VERTEX = 3 // mercX, mercY, altMeters
const POS_BYTES_PER_VERTEX = POS_FLOATS_PER_VERTEX * 4
const META_BYTES_PER_VERTEX = 1 // groupIdx
const GROUP_COUNT = Object.keys(GROUP_INDEX).length

const ATTRIB_POS = 0
const ATTRIB_ALT = 1
const ATTRIB_GROUP = 2

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  ]
}

interface GroupUniforms {
  colors: Float32Array
  sizes: Float32Array
}

function buildGroupUniforms(): GroupUniforms {
  const colors = new Float32Array(GROUP_COUNT * 4)
  const sizes = new Float32Array(GROUP_COUNT)
  for (const [name, idx] of Object.entries(GROUP_INDEX)) {
    const cfg = SATELLITE_GROUPS[name as SatGroup]
    const [r, g, b] = hexToRgb(cfg.color)
    colors[idx * 4 + 0] = r
    colors[idx * 4 + 1] = g
    colors[idx * 4 + 2] = b
    colors[idx * 4 + 3] = cfg.opacity
    sizes[idx] = cfg.dotRadius
  }
  return { colors, sizes }
}

function buildVertexShader(prelude: string, define: string): string {
  return `#version 300 es
${prelude}
${define}
precision highp float;

in vec2 a_pos_merc;
in float a_alt_m;
in float a_group;

uniform float u_altitude_scale;
uniform vec4 u_group_colors[${GROUP_COUNT}];
uniform float u_group_sizes[${GROUP_COUNT}];
uniform float u_pixel_ratio;

out vec4 v_color;

void main() {
    int gi = int(a_group + 0.5);
    v_color = u_group_colors[gi];
    float dotR = u_group_sizes[gi];
    gl_Position = projectTileFor3D(a_pos_merc, a_alt_m * u_altitude_scale);
    gl_PointSize = dotR * 2.5 * u_pixel_ratio;
}
`
}

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;

in vec4 v_color;
out vec4 fragColor;

void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = length(d) * 2.0;
    float core = 1.0 - smoothstep(0.20, 0.30, r);
    float glow = (1.0 - smoothstep(0.30, 1.00, r)) * 0.45;
    float a = clamp(core + glow, 0.0, 1.0) * v_color.a;
    if (a < 0.01) discard;
    fragColor = vec4(v_color.rgb, a);
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
    console.error('[SatelliteLayer] shader compile failed:', gl.getShaderInfoLog(sh))
    console.error(src)
    gl.deleteShader(sh)
    return null
  }
  return sh
}

export class SatelliteLayer implements CustomLayerInterface {
  readonly id = 'satellites-3d'
  readonly type = 'custom' as const
  readonly renderingMode = '3d' as const

  private map: MapLibreMap
  private gl: WebGL2RenderingContext | null = null
  private program: WebGLProgram | null = null
  private programVariantKey: string | null = null
  private posVBO: WebGLBuffer | null = null
  private metaVBO: WebGLBuffer | null = null
  private capacity = 0
  private count = 0

  private uPosMatrix: WebGLUniformLocation | null = null
  private uTileMerc: WebGLUniformLocation | null = null
  private uClipping: WebGLUniformLocation | null = null
  private uTransition: WebGLUniformLocation | null = null
  private uFallback: WebGLUniformLocation | null = null
  private uGroupColors: WebGLUniformLocation | null = null
  private uGroupSizes: WebGLUniformLocation | null = null
  private uAltScale: WebGLUniformLocation | null = null
  private uPixelRatio: WebGLUniformLocation | null = null

  private readonly groupUniforms = buildGroupUniforms()

  constructor(map: MapLibreMap) {
    this.map = map
  }

  onAdd(_map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    if (!(gl instanceof WebGL2RenderingContext)) {
      console.warn('[SatelliteLayer] WebGL2 context required; layer disabled')
      return
    }
    this.gl = gl
    this.posVBO = gl.createBuffer()
    this.metaVBO = gl.createBuffer()
    this.allocate(INITIAL_CAPACITY)
  }

  onRemove(_map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    if (!(gl instanceof WebGL2RenderingContext)) return
    if (this.program) gl.deleteProgram(this.program)
    if (this.posVBO) gl.deleteBuffer(this.posVBO)
    if (this.metaVBO) gl.deleteBuffer(this.metaVBO)
    this.program = null
    this.programVariantKey = null
    this.posVBO = null
    this.metaVBO = null
    this.gl = null
    this.capacity = 0
    this.count = 0
  }

  setData(posBuffer: Float32Array, metaBuffer: Uint8Array, count: number): void {
    const gl = this.gl
    if (!gl || !this.posVBO || !this.metaVBO) {
      this.count = 0
      return
    }
    if (count > this.capacity) {
      this.allocate(Math.max(count, this.capacity * 2))
    }
    if (count > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.posVBO)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, posBuffer, 0, count * POS_FLOATS_PER_VERTEX)
      gl.bindBuffer(gl.ARRAY_BUFFER, this.metaVBO)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, metaBuffer, 0, count * META_BYTES_PER_VERTEX)
    }
    this.count = count
    this.map.triggerRepaint()
  }

  clear(): void {
    if (this.count === 0) return
    this.count = 0
    this.map.triggerRepaint()
  }

  private allocate(capacity: number): void {
    const gl = this.gl
    if (!gl || !this.posVBO || !this.metaVBO) return
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posVBO)
    gl.bufferData(gl.ARRAY_BUFFER, capacity * POS_BYTES_PER_VERTEX, gl.DYNAMIC_DRAW)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.metaVBO)
    gl.bufferData(gl.ARRAY_BUFFER, capacity * META_BYTES_PER_VERTEX, gl.DYNAMIC_DRAW)
    this.capacity = capacity
  }

  render(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    args: CustomRenderMethodInput,
  ): void {
    if (!(gl instanceof WebGL2RenderingContext)) return
    if (this.count === 0 || !this.posVBO || !this.metaVBO) return

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

    if (this.uGroupColors) gl.uniform4fv(this.uGroupColors, this.groupUniforms.colors)
    if (this.uGroupSizes) gl.uniform1fv(this.uGroupSizes, this.groupUniforms.sizes)
    if (this.uAltScale) gl.uniform1f(this.uAltScale, ALTITUDE_SCALE)
    if (this.uPixelRatio)
      gl.uniform1f(this.uPixelRatio, window.devicePixelRatio || 1)

    gl.bindBuffer(gl.ARRAY_BUFFER, this.posVBO)
    gl.enableVertexAttribArray(ATTRIB_POS)
    gl.vertexAttribPointer(ATTRIB_POS, 2, gl.FLOAT, false, POS_BYTES_PER_VERTEX, 0)
    gl.enableVertexAttribArray(ATTRIB_ALT)
    gl.vertexAttribPointer(ATTRIB_ALT, 1, gl.FLOAT, false, POS_BYTES_PER_VERTEX, 8)

    gl.bindBuffer(gl.ARRAY_BUFFER, this.metaVBO)
    gl.enableVertexAttribArray(ATTRIB_GROUP)
    gl.vertexAttribPointer(ATTRIB_GROUP, 1, gl.UNSIGNED_BYTE, false, 1, 0)

    gl.depthMask(false)
    gl.enable(gl.BLEND)
    gl.blendFuncSeparate(
      gl.SRC_ALPHA,
      gl.ONE_MINUS_SRC_ALPHA,
      gl.ONE,
      gl.ONE_MINUS_SRC_ALPHA,
    )

    gl.drawArrays(gl.POINTS, 0, this.count)

    gl.disableVertexAttribArray(ATTRIB_POS)
    gl.disableVertexAttribArray(ATTRIB_ALT)
    gl.disableVertexAttribArray(ATTRIB_GROUP)
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
    gl.bindAttribLocation(program, ATTRIB_GROUP, 'a_group')
    gl.linkProgram(program)
    gl.deleteShader(vs)
    gl.deleteShader(fs)

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('[SatelliteLayer] link failed:', gl.getProgramInfoLog(program))
      gl.deleteProgram(program)
      return
    }

    this.program = program
    this.uPosMatrix = gl.getUniformLocation(program, 'u_projection_matrix')
    this.uTileMerc = gl.getUniformLocation(program, 'u_projection_tile_mercator_coords')
    this.uClipping = gl.getUniformLocation(program, 'u_projection_clipping_plane')
    this.uTransition = gl.getUniformLocation(program, 'u_projection_transition')
    this.uFallback = gl.getUniformLocation(program, 'u_projection_fallback_matrix')
    this.uGroupColors = gl.getUniformLocation(program, 'u_group_colors')
    this.uGroupSizes = gl.getUniformLocation(program, 'u_group_sizes')
    this.uAltScale = gl.getUniformLocation(program, 'u_altitude_scale')
    this.uPixelRatio = gl.getUniformLocation(program, 'u_pixel_ratio')
  }
}
