// Ordered colour ramps (light -> heavy) for each radar source, read off the
// actual pixels each provider serves rather than an approximation. Knowing the
// exact ramp lets us turn a coloured image back into rain intensity levels,
// which is what the motion analysis and the WebGL renderer both work on:
// matching/interpolating/extrapolating *intensity* and colouring it afterwards
// is far more faithful than doing any of that to RGB values, where e.g. heavy
// red rain is darker (lower brightness) than light cyan drizzle.

export type RGBA = [number, number, number, number]

export type Palette = {
  // colors[i] is intensity level i + 1; level 0 means "no rain".
  colors: RGBA[]
}

function hex(h: string, a = 255): RGBA {
  const n = parseInt(h.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a]
}

// MSS dBR rain-area composite. Every colour that product emitted over several
// days of samples, in rain-rate order.
export const MSS_PALETTE: Palette = {
  colors: [
    '#00FFFF',
    '#00EFEF',
    '#00D1D5',
    '#00BABF',
    '#00979A',
    '#00837D',
    '#008045',
    '#008938',
    '#00A235',
    '#00B729',
    '#00CA11',
    '#00DA0D',
    '#00F507',
    '#00FF00',
    '#43FF41',
    '#48FF46',
    '#FFFF3B',
    '#FFFF00',
    '#FFF000',
    '#FFDC00',
    '#FFC600',
    '#FFB200',
    '#FFA500',
    '#FF8A00',
    '#FF7200',
    '#FF4900',
    '#FF1F00',
    '#E50000',
    '#C10000',
    '#B6006A',
    '#D200A5',
    '#D400AA',
    '#FF00FF',
  ].map((c) => hex(c)),
}

// RainViewer's "Universal Blue" ramp (the only scheme their public tiles now
// serve): translucent sand for drizzle, rising in opacity, then light -> dark
// blue, yellow -> orange -> red, and pink for the extreme end.
export const RAINVIEWER_PALETTE: Palette = {
  colors: [
    hex('#636159', 20),
    hex('#66635A', 25),
    hex('#69665C', 30),
    hex('#6C685D', 36),
    hex('#6F6B5F', 41),
    hex('#726E61', 46),
    hex('#757062', 52),
    hex('#787364', 57),
    hex('#7C7565', 62),
    hex('#7F7867', 68),
    hex('#827B69', 73),
    hex('#857D6A', 78),
    hex('#88806C', 84),
    hex('#8B826D', 89),
    hex('#8E856F', 94),
    hex('#928871', 100),
    hex('#9E9375', 110),
    hex('#AA9E79', 120),
    hex('#B6A97E', 130),
    hex('#C2B482', 140),
    hex('#CEC087', 150),
    hex('#D2C48B', 160),
    hex('#D6C88F', 170),
    hex('#DACC93', 180),
    hex('#DED097', 190),
    ...[
      '#88DDEE',
      '#6CD1EB',
      '#51C5E8',
      '#36BAE5',
      '#1BAEE2',
      '#00A3E0',
      '#009AD5',
      '#0091CA',
      '#0088BF',
      '#007FB4',
      '#0077AA',
      '#0070A3',
      '#00699C',
      '#006295',
      '#005B8E',
      '#005588',
      '#005180',
      '#004E78',
      '#004A70',
      '#004768',
      '#FFEE00',
      '#FFE000',
      '#FFD200',
      '#FFC500',
      '#FFB700',
      '#FFAA00',
      '#FF9F00',
      '#FF9500',
      '#FF8B00',
      '#FF8100',
      '#FF4400',
      '#F23600',
      '#E62800',
      '#D91B00',
      '#CD0D00',
      '#C10000',
      '#A80000',
      '#8F0000',
      '#760000',
      '#5D0000',
      '#FFAAFF',
      '#FF8BFF',
    ].map((c) => hex(c)),
  ],
}

// Returns a function mapping one RGBA pixel to its intensity level (0 = no
// rain) by nearest palette colour. Resampling and compression can nudge a
// pixel slightly off its palette entry, so this is a nearest match rather than
// an exact lookup; results are memoised per colour since a radar image only
// ever contains a few dozen distinct values.
export function createLevelDecoder(palette: Palette): (r: number, g: number, b: number, a: number) => number {
  const cache = new Map<number, number>()
  const colors = palette.colors
  return (r, g, b, a) => {
    if (a < 8) return 0
    const key = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0
    const hit = cache.get(key)
    if (hit !== undefined) return hit
    let best = 0
    let bestDist = Infinity
    for (let i = 0; i < colors.length; i++) {
      const c = colors[i]
      const dr = c[0] - r
      const dg = c[1] - g
      const db = c[2] - b
      const da = c[3] - a
      const d = dr * dr + dg * dg + db * db + da * da
      if (d < bestDist) {
        bestDist = d
        best = i + 1
      }
    }
    cache.set(key, best)
    return best
  }
}

// Decodes a whole RGBA buffer into one intensity level per pixel.
export function decodeLevels(rgba: Uint8ClampedArray, palette: Palette): Uint8Array {
  const decode = createLevelDecoder(palette)
  const out = new Uint8Array(rgba.length / 4)
  for (let i = 0; i < out.length; i++) {
    const a = rgba[i * 4 + 3]
    out[i] = a < 8 ? 0 : decode(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2], a)
  }
  return out
}

// The radar layers used to be drawn through a CSS `saturate(1.9)
// contrast(1.2) brightness(1.15)` filter. Re-running a CSS filter over a
// canvas that repaints every animation frame is expensive on phones, so the
// same colour grade is baked into the lookup table once instead (same maths as
// the CSS Filter Effects spec).
function gradeColor([r, g, b, a]: RGBA): RGBA {
  // RainViewer's translucent drizzle band is a neutral sand; saturating it
  // turns it yellow, which on this ramp reads as heavy rain.
  if (a < 255) return [r, g, b, a]
  const s = 1.9
  let R = r / 255
  let G = g / 255
  let B = b / 255
  const sr = (0.213 + 0.787 * s) * R + (0.715 - 0.715 * s) * G + (0.072 - 0.072 * s) * B
  const sg = (0.213 - 0.213 * s) * R + (0.715 + 0.285 * s) * G + (0.072 - 0.072 * s) * B
  const sb = (0.213 - 0.213 * s) * R + (0.715 - 0.715 * s) * G + (0.072 + 0.928 * s) * B
  const clamp = (v: number) => Math.min(1, Math.max(0, v))
  R = clamp(sr)
  G = clamp(sg)
  B = clamp(sb)
  const contrast = (v: number) => clamp((v - 0.5) * 1.2 + 0.5)
  const bright = (v: number) => clamp(v * 1.15)
  return [
    Math.round(bright(contrast(R)) * 255),
    Math.round(bright(contrast(G)) * 255),
    Math.round(bright(contrast(B)) * 255),
    a,
  ]
}

// RGBA lookup table for the renderer: entry 0 is "no rain" (level 1's colour
// at zero alpha, so linear filtering between them only fades alpha instead of
// darkening the edge), entry i is level i.
export function buildLut(palette: Palette): Uint8Array {
  const n = palette.colors.length + 1
  const out = new Uint8Array(n * 4)
  const graded = palette.colors.map(gradeColor)
  out.set([graded[0][0], graded[0][1], graded[0][2], 0], 0)
  graded.forEach((c, i) => out.set(c, (i + 1) * 4))
  return out
}

// Evenly spaced CSS colours along the ramp, light -> heavy, for the legend.
export function legendStops(palette: Palette, count: number): string[] {
  const stops: string[] = []
  const colors = palette.colors.map(gradeColor)
  for (let i = 0; i < count; i++) {
    const [r, g, b, a] = colors[Math.round((i / (count - 1)) * (colors.length - 1))]
    stops.push(`rgba(${r}, ${g}, ${b}, ${Math.max(0.35, a / 255).toFixed(2)})`)
  }
  return stops
}
