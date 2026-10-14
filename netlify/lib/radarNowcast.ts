// Radar nowcast for one point, for the weather companion: reads MSS's latest
// rain-area scans, measures how the rain is moving with the same analysis the
// map runs (src/radar/motion.ts), and traces the motion back from the point to
// see what rain should pass over it in the next two hours.

import { inflateSync } from 'node:zlib'
import { MSS_PALETTE, decodeLevels } from '../../src/radar/palette.ts'
import {
  downsampleLevels,
  measureNowcastMotion,
  sampleField,
  sampleFlow,
  type Field,
  type SteeringWind,
} from '../../src/radar/motion.ts'
import {
  MSS_FLOW_CONFIG,
  MSS_NORTH_EAST,
  MSS_SOUTH_WEST,
  MSS_STEP_MINUTES,
  STEERING_API,
  floorToSgFiveMin,
  mssImageUrl,
  steeringFromResponse,
} from '../../src/radar/mss.ts'

const MINUTE = 60_000
const HORIZON_MIN = 120
const STEP_MIN = 5
const KM_PER_DEG = 111.32
// Rain counts as over the point at this mean level, the threshold the map's
// motion analysis also uses for "raining".
const RAIN_LEVEL = 0.5
// MSS's lowest few levels are faint echoes that often don't reach the ground
// (seen with every rain gauge reading zero), so rain merely near the path only
// counts from the "light" band up.
const LIGHT_LEVEL = 5
// Uncertainty in where extrapolated rain ends up grows with lead time; rain
// within this radius of the traced path is reported as "nearby". Same rate
// as the map's lead-time blur.
const BASE_RADIUS_KM = 1
const RADIUS_KM_PER_MIN = 0.05

const [SOUTH, WEST] = MSS_SOUTH_WEST
const [NORTH, EAST] = MSS_NORTH_EAST

// ---------- PNG decoding ----------

// MSS serves small 8-bit, non-interlaced PNGs; this decodes those (RGBA, RGB
// or palette) to RGBA without pulling in an image library.
function decodePng(buf: Buffer): { w: number; h: number; rgba: Uint8ClampedArray } | null {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null
  let w = 0
  let h = 0
  let colorType = 0
  let palette: Buffer | null = null
  let alpha: Buffer | null = null
  const idat: Buffer[] = []
  for (let i = 8; i + 8 <= buf.length; ) {
    const len = buf.readUInt32BE(i)
    const type = buf.toString('latin1', i + 4, i + 8)
    const data = buf.subarray(i + 8, i + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
      colorType = data[9]
      if (data[8] !== 8 || data[12] !== 0) return null
    } else if (type === 'PLTE') palette = data
    else if (type === 'tRNS') alpha = data
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    i += 12 + len
  }
  const channels = { 2: 3, 3: 1, 6: 4 }[colorType]
  if (!w || !h || !channels || (colorType === 3 && !palette)) return null

  const raw = inflateSync(Buffer.concat(idat))
  const stride = w * channels
  const pixels = new Uint8Array(h * stride)
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const out = y * stride
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[out + x - channels] : 0
      const b = y > 0 ? pixels[out - stride + x] : 0
      const c = x >= channels && y > 0 ? pixels[out - stride + x - channels] : 0
      let pred = 0
      if (filter === 1) pred = a
      else if (filter === 2) pred = b
      else if (filter === 3) pred = (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      pixels[out + x] = (line[x] + pred) & 255
    }
  }

  const rgba = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    if (colorType === 6) rgba.set(pixels.subarray(i * 4, i * 4 + 4), i * 4)
    else if (colorType === 2) rgba.set([pixels[i * 3], pixels[i * 3 + 1], pixels[i * 3 + 2], 255], i * 4)
    else {
      const k = pixels[i]
      rgba.set([palette![k * 3], palette![k * 3 + 1], palette![k * 3 + 2], alpha && k < alpha.length ? alpha[k] : 255], i * 4)
    }
  }
  return { w, h, rgba }
}

// ---------- Fetching ----------

export type Scan = { time: number; grid: Field }

async function fetchScan(time: number): Promise<Scan | null> {
  try {
    const res = await fetch(mssImageUrl(time), {
      headers: { 'User-Agent': 'rainapp-weather-companion/1.0' },
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return null
    const png = decodePng(Buffer.from(await res.arrayBuffer()))
    if (!png) return null
    const levels = decodeLevels(png.rgba, MSS_PALETTE)
    return { time, grid: downsampleLevels(levels, png.w, png.h, MSS_FLOW_CONFIG.factor) }
  } catch {
    return null
  }
}

// The newest published scan: MSS posts each a few minutes after its time.
async function latestScan(now: number): Promise<Scan | null> {
  const newest = floorToSgFiveMin(now)
  const tries = await Promise.all([0, 1, 2, 3, 4].map((i) => fetchScan(newest - i * MSS_STEP_MINUTES * MINUTE)))
  return tries.find((s) => s !== null) ?? null
}

async function fetchSteering(now: number) {
  try {
    const res = await fetch(STEERING_API, { signal: AbortSignal.timeout(8_000) })
    return res.ok ? steeringFromResponse(await res.json(), now) : null
  } catch {
    return null
  }
}

// ---------- Describing ----------

const round = (n: number) => Math.round(n * 10) / 10
const sgClock = (ms: number) => new Date(ms + 8 * 3600_000).toISOString().slice(11, 16)

function compass(bearingDeg: number) {
  const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  return names[Math.round((((bearingDeg % 360) + 360) % 360) / 45) % 8]
}

// Bands on MSS's colour ramp (palette levels 1-33): faint cyan, cyan to
// green, yellow, orange to red, then magenta.
function intensity(level: number) {
  if (level < LIGHT_LEVEL) return 'very light'
  if (level <= 16) return 'light'
  if (level <= 22) return 'moderate'
  if (level <= 28) return 'heavy'
  return 'very heavy'
}

// ---------- Nowcast ----------

export async function radarNowcast(latitude: number, longitude: number, now = Date.now()) {
  if (latitude < SOUTH || latitude > NORTH || longitude < WEST || longitude > EAST) {
    return { error: "That point is outside MSS's Singapore radar coverage." }
  }
  const [latest, steering] = await Promise.all([latestScan(now), fetchSteering(now)])
  if (!latest) return { error: 'MSS radar scans are unavailable right now.' }
  const baseline = MSS_FLOW_CONFIG.baselineMin
  const [prev, prev2] = await Promise.all([
    fetchScan(latest.time - baseline * MINUTE),
    fetchScan(latest.time - 2 * baseline * MINUTE),
  ])
  return nowcastFromScans(latitude, longitude, { latest, prev, prev2, steering, now })
}

// The nowcast itself, given the scans (one baseline apart) and the steering
// wind, kept apart from the fetching so it can be run on chosen fields.
export function nowcastFromScans(
  latitude: number,
  longitude: number,
  {
    latest,
    prev,
    prev2,
    steering,
    now,
  }: { latest: Scan; prev: Scan | null; prev2: Scan | null; steering: SteeringWind | null; now: number },
) {
  const baseline = MSS_FLOW_CONFIG.baselineMin
  const grid = latest.grid
  const midLat = ((SOUTH + NORTH) / 2) * (Math.PI / 180)
  const cellKmX = ((EAST - WEST) * KM_PER_DEG * Math.cos(midLat)) / grid.w
  const cellKmY = ((NORTH - SOUTH) * KM_PER_DEG) / grid.h
  const prior = steering
    ? { dx: (steering.u * baseline) / 60 / cellKmX, dy: (-steering.v * baseline) / 60 / cellKmY }
    : null
  const motion = measureNowcastMotion({
    latest: grid,
    prev: prev?.grid ?? null,
    prev2: prev && prev2 ? prev2.grid : null,
    dt: baseline,
    dt2: baseline,
    prior,
    cellKmX,
    cellKmY,
    config: MSS_FLOW_CONFIG,
  })

  // The point in analysis-grid cells (cell centres at integer coordinates).
  const px = Math.min(grid.w - 1, Math.max(0, ((longitude - WEST) / (EAST - WEST)) * grid.w - 0.5))
  const py = Math.min(grid.h - 1, Math.max(0, ((NORTH - latitude) / (NORTH - SOUTH)) * grid.h - 0.5))
  const distKm = (x: number, y: number) => Math.hypot((x - px) * cellKmX, (y - py) * cellKmY)
  const bearingTo = (x: number, y: number) => (Math.atan2((x - px) * cellKmX, (py - y) * cellKmY) * 180) / Math.PI

  // Strongest rain within radiusKm of a grid position.
  const maxNear = (x: number, y: number, radiusKm: number) => {
    let best = 0
    const rx = Math.ceil(radiusKm / cellKmX)
    const ry = Math.ceil(radiusKm / cellKmY)
    for (let gy = Math.max(0, Math.floor(y) - ry); gy <= Math.min(grid.h - 1, Math.ceil(y) + ry); gy++) {
      for (let gx = Math.max(0, Math.floor(x) - rx); gx <= Math.min(grid.w - 1, Math.ceil(x) + rx); gx++) {
        if (Math.hypot((gx - x) * cellKmX, (gy - y) * cellKmY) <= radiusKm) best = Math.max(best, grid.data[gy * grid.w + gx])
      }
    }
    return best
  }

  // Semi-Lagrangian: the rain over the point L minutes from now is roughly
  // the rain now at the point traced L minutes back along the motion.
  type Step = { lead: number; state: 'rain' | 'nearby' | 'dry'; level: number }
  const steps: Step[] = []
  let x = px
  let y = py
  let horizon: number | null = null
  for (let lead = 0; lead <= HORIZON_MIN; lead += STEP_MIN) {
    if (lead > 0) {
      const f = sampleFlow(motion.flow, x, y, grid.w, grid.h)
      x -= f.u * (STEP_MIN / baseline)
      y -= f.v * (STEP_MIN / baseline)
    }
    const here = sampleField(grid, x, y)
    if (here === null) {
      horizon = lead
      break
    }
    const radius = BASE_RADIUS_KM + RADIUS_KM_PER_MIN * lead
    const near = maxNear(x, y, radius)
    steps.push(
      here >= RAIN_LEVEL
        ? { lead, state: 'rain', level: Math.max(here, near) }
        : near >= LIGHT_LEVEL
          ? { lead, state: 'nearby', level: near }
          : { lead, state: 'dry', level: 0 },
    )
  }

  const at = (lead: number) => sgClock(latest.time + lead * MINUTE)
  const label = (s: Step) =>
    s.state === 'rain' ? `${intensity(s.level)} rain` : s.state === 'nearby' ? `${intensity(s.level)} rain within ~${Math.round(BASE_RADIUS_KM + RADIUS_KM_PER_MIN * s.lead)} km` : 'dry'

  // When traced rain first reaches the point, and when it clears again.
  const first = steps.find((s) => s.state === 'rain')
  const clears = first ? steps.find((s) => s.lead > first.lead && s.state !== 'rain') : undefined
  const firstNear = steps.find((s) => s.state !== 'dry')
  // How far to trust a forecast this far out on this motion estimate.
  const confidence = (lead: number) =>
    lead <= 30 && motion.source === 'radar'
      ? 'high confidence'
      : lead <= 60 && motion.source !== 'none'
        ? 'medium confidence'
        : 'low confidence'
  // Strongest rain the point gets while it's raining there.
  const peakFrom = (from: Step) => {
    let top = 0
    for (const s of steps) if (s.lead >= from.lead && s.state === 'rain') top = Math.max(top, s.level)
    return intensity(top)
  }
  let outlook: string
  if (first && first.lead === 0) {
    outlook =
      `${peakFrom(first)} rain at the point now; ` +
      (clears ? `radar expects it to clear about ${at(clears.lead)} (${confidence(clears.lead)}).` : 'the radar shows more following.')
  } else if (first) {
    outlook =
      `Radar rain (${peakFrom(first)}) is heading for the point, arriving about ${at(first.lead)}, in ${first.lead} min (${confidence(first.lead)})` +
      (clears ? `, and clearing about ${at(clears.lead)}.` : '.')
  } else if (firstNear) {
    outlook = `Radar rain should pass near the point (within a few km) from about ${at(firstNear.lead)}, but not clearly over it (${confidence(firstNear.lead)}).`
  } else {
    outlook = 'No radar rain is heading for the point in the time the radar can see.'
  }

  // Nearest and heaviest rain on the radar right now.
  let nearest: { d: number; x: number; y: number } | null = null
  let nearestLight: { d: number; x: number; y: number } | null = null
  let heaviest10 = 0
  for (let gy = 0; gy < grid.h; gy++) {
    for (let gx = 0; gx < grid.w; gx++) {
      const v = grid.data[gy * grid.w + gx]
      if (v < RAIN_LEVEL) continue
      const d = distKm(gx, gy)
      if (!nearest || d < nearest.d) nearest = { d, x: gx, y: gy }
      if (v >= LIGHT_LEVEL && (!nearestLight || d < nearestLight.d)) nearestLight = { d, x: gx, y: gy }
      if (d <= 10) heaviest10 = Math.max(heaviest10, v)
    }
  }

  const u = (motion.dx * cellKmX) / (baseline / 60)
  const v = (-motion.dy * cellKmY) / (baseline / 60)
  const speed = Math.round(Math.hypot(u, v))
  const toward = compass((Math.atan2(u, v) * 180) / Math.PI)
  const where = (p: { d: number; x: number; y: number }) =>
    `${round(p.d)} km ${compass(bearingTo(p.x, p.y))}, ${intensity(grid.data[p.y * grid.w + p.x])}`
  const motionText =
    motion.source === 'radar'
      ? `rain moving toward ${toward} at ${speed} km/h, tracked from the radar`
      : motion.source === 'steering'
        ? `radar too patchy to track; model steering wind carries rain toward ${toward} at ${speed} km/h`
        : 'motion unknown; assuming rain stays put'

  return {
    source: `MSS rain-area radar (Singapore only, about 63 x 35 km), scan at ${sgClock(latest.time)} SGT, ${Math.max(0, Math.round((now - latest.time) / MINUTE))} min old`,
    at_point_now: label(steps[0]),
    nearest_rain_now: nearest
      ? where(nearest) + (nearestLight && nearestLight.d > nearest.d ? `; nearest light or heavier: ${where(nearestLight)}` : '')
      : 'none on the radar',
    heaviest_within_10km: heaviest10 ? intensity(heaviest10) : 'none',
    motion: motionText,
    outlook,
    every_10_min: steps.filter((s) => s.lead % 10 === 0).map((s) => `${at(s.lead)} ${label(s)}`),
    ...(horizon !== null
      ? { coverage: `Upwind, the radar's edge is reached at ${at(horizon)}: rain arriving later is outside the radar now and can't be seen yet.` }
      : {}),
    limits:
      "Extrapolation of existing rain only. Showers that form overhead (common on Singapore afternoons) don't show until they appear, and cells can grow or die out. Most reliable within the first hour.",
  }
}
