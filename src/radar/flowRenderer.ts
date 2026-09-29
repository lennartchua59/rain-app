import type { Field, FlowField } from './motion'

// GPU renderer for the radar layer. Every displayed frame is synthesised from
// real scans on the fly, so time can move continuously instead of jumping
// scan to scan:
//  - between two scans, both are advected along the measured motion toward
//    the requested instant and blended (motion-compensated interpolation,
//    the technique RainViewer's own app uses), so cells glide rather than
//    crossfade;
//  - past the latest scan, it is advected forward along the measured motion
//    (semi-Lagrangian backtracking, so curved/rotating flow works), with the
//    measured intensity trend and a lead-time smoothing that erodes small
//    features first, which is how forecast skill actually decays.
// Intensity levels are interpolated and only then coloured through the
// palette, so edges stay smooth at any zoom instead of showing source pixels.

const VERT = `#version 300 es
in vec2 aPos;
uniform vec4 uView; // uv rect of the domain this canvas covers: x0, y0, x1, y1
out vec2 vUv;
void main() {
  vec2 t = aPos * 0.5 + 0.5;
  vUv = vec2(mix(uView.x, uView.z, t.x), mix(uView.w, uView.y, t.y));
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uA;
uniform sampler2D uB;
uniform sampler2D uFlow;
uniform sampler2D uTrend;
uniform sampler2D uLut;
uniform int uMode;        // 0 = interpolate A -> B, 1 = extrapolate A forward
uniform float uT;         // mode 0: fraction A -> B. mode 1: intervals ahead
uniform vec2 uCellUv;     // one analysis cell, in uv
uniform float uTrendGain; // mode 1: how many intervals of trend to apply
uniform vec2 uBlur;       // mode 1: lead-time smoothing radius, in uv
uniform float uLutSize;
uniform float uOpacity;

vec2 flowAt(vec2 p) { return texture(uFlow, p).rg * uCellUv; }

// Frames store (level, presence): r = level where it's raining, g = 1 where
// it's raining. Filtering both and dividing (like premultiplied alpha) keeps
// an intense cell's edge fading out in its own colour — filtering the level
// alone would ramp it down through every lighter colour on the way to zero,
// painting a false light-rain halo round every cell.

// Unnormalised (premultiplied) sample, for averaging several taps.
vec2 rainSumLod(sampler2D s, vec2 p, float lod) {
  if (p.x < 0.0 || p.y < 0.0 || p.x > 1.0 || p.y > 1.0) return vec2(0.0);
  vec4 t = textureLod(s, p, lod);
  return vec2(t.r * 255.0, t.g);
}

// Plain bilinear turns each lone radar pixel into a diamond once magnified;
// a small 5-tap tent around the point rounds contours off instead.
vec2 rainSmooth(sampler2D s, vec2 p, float lod) {
  vec2 o = 0.4 * exp2(lod) / vec2(textureSize(s, 0));
  return (rainSumLod(s, p, lod) * 2.0 +
          rainSumLod(s, p + o, lod) + rainSumLod(s, p - o, lod) +
          rainSumLod(s, p + vec2(o.x, -o.y), lod) + rainSumLod(s, p + vec2(-o.x, o.y), lod)) / 6.0;
}

// (level, coverage) at a point.
vec2 rain(sampler2D s, vec2 p) {
  vec2 t = rainSmooth(s, p, 0.0);
  return t.y > 0.002 ? vec2(t.x / t.y, t.y) : vec2(0.0);
}

vec4 colorize(vec2 r) {
  float c = clamp(r.x, 0.0, uLutSize - 1.0);
  vec4 col = texture(uLut, vec2((c + 0.5) / uLutSize, 0.5));
  // Crisp, anti-aliased contour where coverage crosses ~half, plus a fade
  // for levels decaying below the lightest colour.
  col.a *= smoothstep(0.25, 0.65, r.y) * smoothstep(0.3, 1.0, r.x);
  return vec4(col.rgb * col.a, col.a);
}

void main() {
  vec4 color;
  if (uMode == 0) {
    vec2 pa = vUv;
    vec2 pb = vUv;
    for (int i = 0; i < 4; i++) {
      pa -= flowAt(pa) * (uT * 0.25);
      pb += flowAt(pb) * ((1.0 - uT) * 0.25);
    }
    color = mix(colorize(rain(uA, pa)), colorize(rain(uB, pb)), uT);
  } else {
    vec2 p = vUv;
    for (int i = 0; i < 6; i++) p -= flowAt(p) * (uT / 6.0);
    // Rain arriving from beyond the radar image is unknown, not absent.
    // Keeping what's there now (persistence) instead of drawing it dry
    // scored clearly better in backtests on the small SG image, and made no
    // difference on the wide regional one.
    if (p.x < 0.0 || p.y < 0.0 || p.x > 1.0 || p.y > 1.0) p = vUv;
    // Lead-time smoothing from the mip chain (a true low-pass, so small
    // cells soften rather than ghosting into sparse-tap stars), with four
    // half-radius taps to round off the mip level's box shape.
    float lod = max(0.0, log2(max(uBlur.x * float(textureSize(uA, 0).x), 1e-3)));
    vec2 d = uBlur * 0.5;
    vec2 sum = (rainSmooth(uA, p, lod) * 4.0 +
                rainSumLod(uA, p + d, lod) + rainSumLod(uA, p - d, lod) +
                rainSumLod(uA, p + vec2(d.x, -d.y), lod) + rainSumLod(uA, p + vec2(-d.x, d.y), lod)) / 8.0;
    vec2 r = sum.y > 0.002 ? vec2(sum.x / sum.y, sum.y) : vec2(0.0);
    if (r.y > 0.0) r.x += texture(uTrend, p).r * uTrendGain;
    color = colorize(r);
  }
  outColor = color * uOpacity;
}`

export type DrawParams = {
  mode: 'interpolate' | 'extrapolate'
  a: string
  b?: string
  flow: string | null
  trend?: string | null
  t: number
  trendGain?: number
  // Analysis grid dimensions, to convert flow (cells) into uv.
  gridW: number
  gridH: number
  blurUv?: [number, number]
  opacity: number
  view: [number, number, number, number]
}

export class FlowRenderer {
  private gl: WebGL2RenderingContext
  private program: WebGLProgram
  private uniforms: Record<string, WebGLUniformLocation | null> = {}
  private textures = new Map<string, WebGLTexture>()
  private lut: WebGLTexture | null = null
  private lutSize = 1
  private zeroFlow: WebGLTexture
  private zeroTrend: WebGLTexture

  static create(canvas: HTMLCanvasElement): FlowRenderer | null {
    try {
      const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: false })
      if (!gl) return null
      return new FlowRenderer(gl)
    } catch {
      return null
    }
  }

  private constructor(gl: WebGL2RenderingContext) {
    this.gl = gl
    const program = gl.createProgram()!
    for (const [type, src] of [
      [gl.VERTEX_SHADER, VERT],
      [gl.FRAGMENT_SHADER, FRAG],
    ] as const) {
      const shader = gl.createShader(type)!
      gl.shaderSource(shader, src)
      gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'shader')
      gl.attachShader(program, shader)
    }
    gl.bindAttribLocation(program, 0, 'aPos')
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'link')
    this.program = program
    gl.useProgram(program)
    for (const name of [
      'uView',
      'uA',
      'uB',
      'uFlow',
      'uTrend',
      'uLut',
      'uMode',
      'uT',
      'uCellUv',
      'uTrendGain',
      'uBlur',
      'uLutSize',
      'uOpacity',
    ]) {
      this.uniforms[name] = gl.getUniformLocation(program, name)
    }
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    this.zeroFlow = this.makeTexture(gl.RG16F, gl.RG, gl.FLOAT, 1, 1, new Float32Array(2))
    this.zeroTrend = this.makeTexture(gl.R16F, gl.RED, gl.FLOAT, 1, 1, new Float32Array(1))
  }

  get lost() {
    return this.gl.isContextLost()
  }

  private makeTexture(
    internal: number,
    format: number,
    type: number,
    w: number,
    h: number,
    data: ArrayBufferView,
    filter: number = this.gl.LINEAR,
  ): WebGLTexture {
    const gl = this.gl
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data)
    return tex
  }

  private replace(key: string, tex: WebGLTexture) {
    const old = this.textures.get(key)
    if (old) this.gl.deleteTexture(old)
    this.textures.set(key, tex)
  }

  has(key: string) {
    return this.textures.has(key)
  }

  delete(key: string) {
    const tex = this.textures.get(key)
    if (tex) this.gl.deleteTexture(tex)
    this.textures.delete(key)
  }

  keys() {
    return [...this.textures.keys()]
  }

  setLut(lut: Uint8Array) {
    const gl = this.gl
    if (this.lut) gl.deleteTexture(this.lut)
    this.lutSize = lut.length / 4
    this.lut = this.makeTexture(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, this.lutSize, 1, lut)
  }

  uploadLevels(key: string, levels: Uint8Array, w: number, h: number) {
    const gl = this.gl
    // (level, presence) pairs — see the shader's note above rainSumLod.
    const rg = new Uint8Array(w * h * 2)
    for (let i = 0; i < w * h; i++) {
      rg[i * 2] = levels[i]
      rg[i * 2 + 1] = levels[i] > 0 ? 255 : 0
    }
    const tex = this.makeTexture(gl.RG8, gl.RG, gl.UNSIGNED_BYTE, w, h, rg)
    // Mips feed the forecast's lead-time smoothing (and keep zoomed-out
    // views from aliasing).
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    gl.generateMipmap(gl.TEXTURE_2D)
    this.replace(key, tex)
  }

  uploadFlow(key: string, flow: FlowField) {
    const gl = this.gl
    const data = new Float32Array(flow.w * flow.h * 2)
    for (let i = 0; i < flow.w * flow.h; i++) {
      data[i * 2] = flow.u[i]
      data[i * 2 + 1] = flow.v[i]
    }
    this.replace(key, this.makeTexture(gl.RG16F, gl.RG, gl.FLOAT, flow.w, flow.h, data))
  }

  uploadTrend(key: string, trend: Field) {
    const gl = this.gl
    this.replace(key, this.makeTexture(gl.R16F, gl.RED, gl.FLOAT, trend.w, trend.h, trend.data))
  }

  clear() {
    const gl = this.gl
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  draw(p: DrawParams): boolean {
    const gl = this.gl
    const a = this.textures.get(p.a)
    const b = p.b ? this.textures.get(p.b) : a
    if (!a || !b || !this.lut) return false
    const flow = (p.flow && this.textures.get(p.flow)) || this.zeroFlow
    const trend = (p.trend && this.textures.get(p.trend)) || this.zeroTrend
    const u = this.uniforms

    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.useProgram(this.program)
    const bind = (unit: number, tex: WebGLTexture, name: string) => {
      gl.activeTexture(gl.TEXTURE0 + unit)
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.uniform1i(u[name], unit)
    }
    bind(0, a, 'uA')
    bind(1, b, 'uB')
    bind(2, flow, 'uFlow')
    bind(3, trend, 'uTrend')
    bind(4, this.lut, 'uLut')
    gl.uniform4f(u.uView, p.view[0], p.view[1], p.view[2], p.view[3])
    gl.uniform1i(u.uMode, p.mode === 'interpolate' ? 0 : 1)
    gl.uniform1f(u.uT, p.t)
    gl.uniform2f(u.uCellUv, 1 / p.gridW, 1 / p.gridH)
    gl.uniform1f(u.uTrendGain, p.trendGain ?? 0)
    gl.uniform2f(u.uBlur, p.blurUv?.[0] ?? 0, p.blurUv?.[1] ?? 0)
    gl.uniform1f(u.uLutSize, this.lutSize)
    gl.uniform1f(u.uOpacity, p.opacity)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    return true
  }

  dispose() {
    for (const tex of this.textures.values()) this.gl.deleteTexture(tex)
    this.textures.clear()
    this.gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}
