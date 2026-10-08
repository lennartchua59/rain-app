import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { MapContainer, useMap } from 'react-leaflet'
import L from 'leaflet'
import { maplibreGL } from '@maplibre/maplibre-gl-leaflet'
import { setWorkerUrl } from 'maplibre-gl'
// MapLibre decodes tiles in a separate worker file, which Vite's dependency
// bundling otherwise loses; bundle it explicitly and tell MapLibre where it is.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import 'leaflet/dist/leaflet.css'
import 'maplibre-gl/dist/maplibre-gl.css'
import './RadarMap.css'
import {
  FlowRadarLayer,
  type FlowKeyframe,
  type FlowSourceConfig,
  type FlowStatus,
  type MotionSource,
  type SteeringWind,
} from './radar/FlowRadarLayer'
import { MSS_PALETTE, RAINVIEWER_PALETTE, legendStops } from './radar/palette'

const SINGAPORE: [number, number] = [1.3521, 103.8198]

// Bounding box of MSS's own rain-area radar composite (same source their site embeds).
const MSS_SOUTH_WEST: L.LatLngTuple = [1.156, 103.565]
const MSS_NORTH_EAST: L.LatLngTuple = [1.475, 104.13]
const MSS_BOUNDS = L.latLngBounds(MSS_SOUTH_WEST, MSS_NORTH_EAST)

const WIND_SPEED_API = 'https://api-open.data.gov.sg/v2/real-time/api/wind-speed'
const WIND_DIRECTION_API = 'https://api-open.data.gov.sg/v2/real-time/api/wind-direction'
const PSI_API = 'https://api-open.data.gov.sg/v2/real-time/api/psi'
const PM25_API = 'https://api-open.data.gov.sg/v2/real-time/api/pm25'
const RAINVIEWER_API = 'https://api.rainviewer.com/public/weather-maps.json'
// OpenFreeMap's build of the Positron style — the same design as CARTO's
// Positron raster tiles this app used before CARTO started requiring an API
// key, but free and keyless. Vector, so it stays sharp at every zoom.
const BASEMAP_STYLE = 'https://tiles.openfreemap.org/styles/positron'
setWorkerUrl(maplibreWorkerUrl)
// Rain cells are carried by the wind 1.5-3km up, not the surface wind the
// weather stations measure (which is slowed and turned by friction, and
// often points a different way entirely). Open-Meteo's 850/700 hPa model wind
// over Singapore is the standard "steering flow" first guess for storm motion.
const STEERING_API =
  'https://api.open-meteo.com/v1/forecast?latitude=1.35&longitude=103.82' +
  '&hourly=wind_speed_850hPa,wind_direction_850hPa,wind_speed_700hPa,wind_direction_700hPa' +
  '&past_hours=2&forecast_hours=4&timezone=UTC'
// Same-origin path to MSS's radar images (see vite.config.ts), so their
// pixels can be read for motion tracking.
const MSS_PROXY_BASE = '/mss-radar'
const KNOTS_TO_KMH = 1.852
const KM_PER_DEG_LAT = 111
// RainViewer's public composite only has native imagery up to this zoom for this
// region; requesting deeper zooms returns a "Zoom Level Not Supported" placeholder.
const RAINVIEWER_MAX_NATIVE_ZOOM = 7
// The slippy-tile grid RainViewer serves on; z/x/y are identical whether the
// 256px or 512px asset is requested, so this never changes.
const RAINVIEWER_GRID_SIZE = 256
// RainViewer's own web/app client requests the 512px (@2x) render of that same
// grid on hi-DPI displays (their bundle: tileSize = (isRetina ? 2 : 1) * 256),
// which is four times the pixels per cell. Matching it is the single biggest
// fidelity win available on the past/live path.
const RAINVIEWER_TILE_SIZE = 512
// The opacity RainViewer's own client defaults to for the radar layer
// (their bundle: opacity ?? 83, divided by 100). MSS keeps its own value.
const RAINVIEWER_LAYER_OPACITY = 0.83
// Their public tiles now only serve the "Universal Blue" scheme whatever is
// asked for here; kept as a named constant so the URL shape stays obvious.
const RAINVIEWER_TILE_STYLE = '4/1_1'
// Crossfade duration for swapping radar frames on the fallback image layers —
// must match the CSS `transition: opacity` duration on .radar-image.
const FADE_MS = 600

// Slippy-map tile math (standard Web Mercator), used to stitch RainViewer's
// tiled mosaic into one raster — RainViewer only ever gives us a tile grid.
function lonToTileX(lon: number, z: number) {
  return Math.floor(((lon + 180) / 360) * 2 ** z)
}
function latToTileY(lat: number, z: number) {
  const rad = (lat * Math.PI) / 180
  return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z)
}
function tileXToLon(x: number, z: number) {
  return (x / 2 ** z) * 360 - 180
}
function tileYToLat(y: number, z: number) {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
}

// Extra tiles of margin fetched around the SG/JB bounding box, so rain
// approaching from well outside Singapore is already in the raster.
const RAINVIEWER_TILE_PADDING = 1
const RV_MIN_TILE_X = lonToTileX(MSS_SOUTH_WEST[1], RAINVIEWER_MAX_NATIVE_ZOOM) - RAINVIEWER_TILE_PADDING
const RV_MAX_TILE_X = lonToTileX(MSS_NORTH_EAST[1], RAINVIEWER_MAX_NATIVE_ZOOM) + RAINVIEWER_TILE_PADDING
const RV_MIN_TILE_Y = latToTileY(MSS_NORTH_EAST[0], RAINVIEWER_MAX_NATIVE_ZOOM) - RAINVIEWER_TILE_PADDING
const RV_MAX_TILE_Y = latToTileY(MSS_SOUTH_WEST[0], RAINVIEWER_MAX_NATIVE_ZOOM) + RAINVIEWER_TILE_PADDING

// Full stitched raster size, known up front from the tile grid.
const RV_STITCH_W = (RV_MAX_TILE_X - RV_MIN_TILE_X + 1) * RAINVIEWER_TILE_SIZE
const RV_STITCH_H = (RV_MAX_TILE_Y - RV_MIN_TILE_Y + 1) * RAINVIEWER_TILE_SIZE
// One z7 tile is ~313km, so the padded stitch is ~940km across. Everything
// works on this centred square window (~470km) instead, which still covers
// the viewport with room to pan and spends the pixel budget where it's seen.
const RV_WINDOW = {
  size: Math.round(Math.min(RV_STITCH_W, RV_STITCH_H) * 0.5),
  get x() {
    return Math.round((RV_STITCH_W - this.size) / 2)
  },
  get y() {
    return Math.round((RV_STITCH_H - this.size) / 2)
  },
}
// Exact geographic bounds of that window, via fractional tile coordinates.
const RAINVIEWER_WINDOW_BOUNDS = L.latLngBounds(
  [
    tileYToLat(RV_MIN_TILE_Y + (RV_WINDOW.y + RV_WINDOW.size) / RAINVIEWER_TILE_SIZE, RAINVIEWER_MAX_NATIVE_ZOOM),
    tileXToLon(RV_MIN_TILE_X + RV_WINDOW.x / RAINVIEWER_TILE_SIZE, RAINVIEWER_MAX_NATIVE_ZOOM),
  ],
  [
    tileYToLat(RV_MIN_TILE_Y + RV_WINDOW.y / RAINVIEWER_TILE_SIZE, RAINVIEWER_MAX_NATIVE_ZOOM),
    tileXToLon(RV_MIN_TILE_X + (RV_WINDOW.x + RV_WINDOW.size) / RAINVIEWER_TILE_SIZE, RAINVIEWER_MAX_NATIVE_ZOOM),
  ],
)

// Legend ramps, taken from the exact palettes each source serves.
const MSS_LEGEND = legendStops(MSS_PALETTE, 10)
const RAINVIEWER_LEGEND = legendStops(RAINVIEWER_PALETTE, 10)

// Motion-analysis tuning per source. MSS images are 217x120px over ~63x35km
// (~0.3km/px) with a scan every 5 min; RainViewer's window is 768px over
// ~470km (~0.6km/px) every 10 min. Analysis cells end up ~0.6km (MSS) and
// ~2.4km (RainViewer), and search radii cover storm motion up to roughly
// 40km/h either side of the steering-wind first guess.
const MSS_FLOW_CONFIG: FlowSourceConfig = {
  factor: 2,
  flowCell: 8,
  blockHalf: 8,
  localRadius: 3,
  baselineMin: 15,
  searchRadius: 16,
  pairRadius: 6,
  // ~90 km² of this 63x35km image. Below that it's scattered specks, whose
  // tracked "motion" was measured jumping around at random.
  minCoverage: 0.04,
}
const RAINVIEWER_FLOW_CONFIG: FlowSourceConfig = {
  factor: 4,
  flowCell: 12,
  blockHalf: 10,
  localRadius: 3,
  baselineMin: 30,
  searchRadius: 12,
  pairRadius: 4,
  // ~1,100 km² of this ~470km window.
  minCoverage: 0.005,
}

// A single frame from RainViewer's own radar mosaic, matched by closest
// published timestamp to the requested epoch.
function closestRainviewerFrame(frames: RainviewerFrame[], targetEpoch: number): RainviewerFrame | null {
  let best: RainviewerFrame | null = null
  let bestDiff = Infinity
  for (const f of frames) {
    const diff = Math.abs(f.time * 1000 - targetEpoch)
    if (diff < bestDiff) {
      bestDiff = diff
      best = f
    }
  }
  return best
}

type RadarFrame = {
  epoch: number // real UTC epoch ms, floored to a 5-minute SGT boundary
  url: string
}

type WindVector = {
  speedKmh: number
  // Compass bearing the air is moving TOWARD (i.e. the direction rain cells drift).
  towardBearingDeg: number
}

// A single station's wind, kept as east/north km/h components (not speed+bearing)
// so band interpolation can just linearly blend them.
type StationWind = { lat: number; lon: number; u: number; v: number }

// The regional average plus each station's own reading.
type WindField = { average: WindVector; stations: StationWind[] }

type RainviewerFrame = { time: number; path: string }
type RainviewerData = {
  host: string
  past: RainviewerFrame[]
}

// Which radar mosaic to render — MSS's own official Singapore composite, or
// RainViewer's global stitched-radar mosaic.
type RadarSource = 'mss' | 'rainviewer'

// Minimal single-color line icons (currentColor) replacing platform emoji —
// emoji render as full-color glyphs that clash with the app's monochrome
// glass/HUD look and vary between OSes; these stay consistent everywhere.
function IconWind({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    >
      <path d="M3 8h10.5a2.5 2.5 0 1 0 -2.5 -2.5" />
      <path d="M3 12.5h14a2.5 2.5 0 1 1 -2.5 2.5" />
      <path d="M3 17h8" />
    </svg>
  )
}

function IconWarning({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3.5 21 19.5H3Z" />
      <path d="M12 9.5v5" />
      <circle cx="12" cy="17" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  )
}

function IconLocate({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" strokeLinecap="round" />
    </svg>
  )
}

function IconRefresh({ size = 13, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M20 11A8 8 0 0 0 6.3 6.3L4 8.6" />
      <path d="M4 4v4.6h4.6" />
      <path d="M4 13a8 8 0 0 0 13.7 4.7L20 15.4" />
      <path d="M20 20v-4.6h-4.6" />
    </svg>
  )
}

function IconInfo({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="7.75" r="0.9" fill="currentColor" stroke="none" />
      <path d="M12 11v6" strokeLinecap="round" />
    </svg>
  )
}

function IconPlay({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <path d="M7 4.5v15l13-7.5z" />
    </svg>
  )
}

function IconPause({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <rect x="6" y="4.5" width="4.5" height="15" rx="1" />
      <rect x="13.5" y="4.5" width="4.5" height="15" rx="1" />
    </svg>
  )
}

function pad(n: number) {
  return String(n).padStart(2, '0')
}

// Returns the SGT wall-clock field values for a real UTC epoch, computed manually
// (not via the browser's local timezone) so this works correctly for any viewer.
function sgFields(epoch: number) {
  const d = new Date(epoch + 8 * 3600 * 1000)
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    da: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
  }
}

function floorToSgFiveMin(epoch: number) {
  const sgMs = epoch + 8 * 3600 * 1000
  const flooredSg = Math.floor(sgMs / (5 * 60 * 1000)) * 5 * 60 * 1000
  return flooredSg - 8 * 3600 * 1000
}

function mssImagePath(epoch: number) {
  const { y, mo, da, h, mi } = sgFields(epoch)
  const dt = `${y}${pad(mo)}${pad(da)}${pad(h)}${pad(mi)}`
  return `/50km/v2/dpsri_70km_${dt}0000dBR.dpsri.png`
}

function mssImageUrl(epoch: number) {
  return `https://www.weather.gov.sg/files/rainarea${mssImagePath(epoch)}`
}

function formatTime(epoch: number) {
  return new Date(epoch).toLocaleTimeString('en-SG', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Asia/Singapore',
  })
}

function compassPoint(bearingDeg: number) {
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(bearingDeg / 45) % 8]
}

// A short, sharp tap for each timeline tick crossed while dragging. iOS
// Safari (including a home-screen installed PWA) has never implemented the
// Vibration API — there's no web-visible way to reach the Taptic Engine
// there — so this is a no-op on iPhone regardless of feature-detection, but
// it does give real haptic ticks on Android/Chrome, and costs nothing to
// leave in for when/if WebKit ever adds support.
function triggerTickHaptic() {
  navigator.vibrate?.(8)
}

function preloadImage(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(true)
    img.onerror = () => resolve(false)
    img.src = url
  })
}

function loadImage(url: string, crossOrigin = false): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image()
    if (crossOrigin) img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = url
  })
}

// Keyframe keys for MSS are the scan's epoch.
function loadMssFrame(key: string) {
  return loadImage(`${MSS_PROXY_BASE}${mssImagePath(Number(key))}`)
}

// Fetches the small tile grid covering SG/JB for one RainViewer frame and
// draws it into one raster, cropped to RV_WINDOW. RainViewer's tiles send
// CORS headers, so the result can be read back pixel by pixel.
async function stitchRainviewerFrame(host: string, path: string): Promise<HTMLCanvasElement | null> {
  const cols = RV_MAX_TILE_X - RV_MIN_TILE_X + 1
  const rows = RV_MAX_TILE_Y - RV_MIN_TILE_Y + 1
  const stitch = document.createElement('canvas')
  stitch.width = cols * RAINVIEWER_TILE_SIZE
  stitch.height = rows * RAINVIEWER_TILE_SIZE
  const ctx = stitch.getContext('2d')!
  const loads: Promise<boolean>[] = []
  for (let ty = RV_MIN_TILE_Y; ty <= RV_MAX_TILE_Y; ty++) {
    for (let tx = RV_MIN_TILE_X; tx <= RV_MAX_TILE_X; tx++) {
      const url = `${host}${path}/${RAINVIEWER_TILE_SIZE}/${RAINVIEWER_MAX_NATIVE_ZOOM}/${tx}/${ty}/${RAINVIEWER_TILE_STYLE}.png`
      loads.push(
        loadImage(url, true).then((img) => {
          if (!img) return false
          ctx.drawImage(img, (tx - RV_MIN_TILE_X) * RAINVIEWER_TILE_SIZE, (ty - RV_MIN_TILE_Y) * RAINVIEWER_TILE_SIZE)
          return true
        }),
      )
    }
  }
  const results = await Promise.all(loads)
  if (!results.some(Boolean)) return null
  const windowed = document.createElement('canvas')
  windowed.width = RV_WINDOW.size
  windowed.height = RV_WINDOW.size
  windowed
    .getContext('2d')!
    .drawImage(stitch, RV_WINDOW.x, RV_WINDOW.y, RV_WINDOW.size, RV_WINDOW.size, 0, 0, RV_WINDOW.size, RV_WINDOW.size)
  return windowed
}

// Finds the actual latest MSS frame that exists, instead of guessing a fixed
// publish-latency buffer (which was either too tight — showing a blank frame
// — or too loose — showing a "LIVE" frame that's really several minutes
// stale). Starts at the real current 5-minute boundary and steps backward
// until an image genuinely loads.
async function probeLatestMssEpoch(maxStepsBack = 4): Promise<number | null> {
  const candidate = floorToSgFiveMin(Date.now())
  for (let i = 0; i <= maxStepsBack; i++) {
    const epoch = candidate - i * STEP_MINUTES * 60 * 1000
    if (await preloadImage(mssImageUrl(epoch))) return epoch
  }
  return null
}

// Fetches every station's own wind vector (not just one regional average),
// for the wind arrows and as a last-resort drift estimate.
async function fetchWindField(): Promise<WindField | null> {
  try {
    const [speedRes, dirRes] = await Promise.all([fetch(WIND_SPEED_API), fetch(WIND_DIRECTION_API)])
    if (!speedRes.ok || !dirRes.ok) return null
    const speedJson = await speedRes.json()
    const dirJson = await dirRes.json()
    const stationLocation = new Map<string, { lat: number; lon: number }>(
      speedJson.data.stations.map((s: { id: string; location: { latitude: number; longitude: number } }) => [
        s.id,
        { lat: s.location.latitude, lon: s.location.longitude },
      ]),
    )
    const speedByStation = new Map<string, number>(
      speedJson.data.readings[0].data.map((r: { stationId: string; value: number }) => [r.stationId, r.value]),
    )
    const dirByStation = new Map<string, number>(
      dirJson.data.readings[0].data.map((r: { stationId: string; value: number }) => [r.stationId, r.value]),
    )
    const stations: StationWind[] = []
    let sumU = 0
    let sumV = 0
    let count = 0
    for (const [stationId, speedKnots] of speedByStation) {
      const dirDeg = dirByStation.get(stationId)
      const loc = stationLocation.get(stationId)
      if (dirDeg === undefined || !loc) continue
      const speedKmh = speedKnots * KNOTS_TO_KMH
      const fromRad = (dirDeg * Math.PI) / 180
      // Wind "direction" is where it blows FROM, so velocity points the other way.
      const u = -speedKmh * Math.sin(fromRad)
      const v = -speedKmh * Math.cos(fromRad)
      stations.push({ lat: loc.lat, lon: loc.lon, u, v })
      sumU += u
      sumV += v
      count++
    }
    if (count === 0) return null
    const avgU = sumU / count
    const avgV = sumV / count
    const speedKmh = Math.sqrt(avgU * avgU + avgV * avgV)
    const towardBearingDeg = ((Math.atan2(avgU, avgV) * 180) / Math.PI + 360) % 360
    return { average: { speedKmh, towardBearingDeg }, stations }
  } catch {
    return null
  }
}

// Model steering wind over Singapore for the current hour: the vector mean of
// the 850 and 700 hPa winds, as east/north km/h.
async function fetchSteeringWind(): Promise<SteeringWind | null> {
  try {
    const res = await fetch(STEERING_API)
    if (!res.ok) return null
    const json = await res.json()
    const h = json.hourly
    const times: number[] = h.time.map((t: string) => Date.parse(`${t}Z`))
    let best = 0
    for (let i = 1; i < times.length; i++) {
      if (Math.abs(times[i] - Date.now()) < Math.abs(times[best] - Date.now())) best = i
    }
    let u = 0
    let v = 0
    let n = 0
    for (const level of ['850hPa', '700hPa']) {
      const speed = h[`wind_speed_${level}`]?.[best]
      const from = h[`wind_direction_${level}`]?.[best]
      if (typeof speed !== 'number' || typeof from !== 'number') continue
      const rad = (from * Math.PI) / 180
      u += -speed * Math.sin(rad)
      v += -speed * Math.cos(rad)
      n++
    }
    return n > 0 ? { u: u / n, v: v / n } : null
  } catch {
    return null
  }
}

// Inverse-distance-weighted blend of nearby stations' wind vectors at one point.
function interpolateWindAt(stations: StationWind[], lat: number, lon: number): { u: number; v: number } {
  let sumWeight = 0
  let sumU = 0
  let sumV = 0
  for (const s of stations) {
    const dLat = (s.lat - lat) * KM_PER_DEG_LAT
    const dLon = (s.lon - lon) * KM_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180)
    const distKm = Math.sqrt(dLat * dLat + dLon * dLon)
    const weight = 1 / (distKm * distKm + 1)
    sumWeight += weight
    sumU += weight * s.u
    sumV += weight * s.v
  }
  if (sumWeight === 0) return { u: 0, v: 0 }
  return { u: sumU / sumWeight, v: sumV / sumWeight }
}

// Confidence fades the further out the extrapolation reaches.
function nowcastFade(minutes: number) {
  return Math.max(0.2, 1 - (minutes / FUTURE_MINUTES) * 0.75)
}

// Fallback only (used when the motion-tracked FlowRadarLayer can't run, e.g.
// no WebGL2 or the MSS proxy isn't deployed). Georeferenced single-image
// radar overlay that crossfades between 5-min scans.
function RadarImageLayer({
  frame,
  opacity,
  visible,
}: {
  frame: RadarFrame | null
  opacity: number
  visible: boolean
}) {
  const map = useMap()
  const layersRef = useRef<Map<number, L.ImageOverlay>>(new Map())
  const activeEpochRef = useRef<number | null>(null)
  const removalTimersRef = useRef<Map<number, number>>(new Map())

  useEffect(() => {
    const cache = layersRef.current
    const timers = removalTimersRef.current
    return () => {
      timers.forEach((id) => window.clearTimeout(id))
      timers.clear()
      cache.forEach((layer) => map.removeLayer(layer))
      cache.clear()
    }
  }, [map])

  useEffect(() => {
    if (!frame) return
    let cancelled = false
    const cache = layersRef.current
    const timers = removalTimersRef.current
    const existing = cache.get(frame.epoch)

    function show(layer: L.ImageOverlay, freshlyCreated: boolean) {
      if (cancelled) return
      // Cancel any pending removal for a frame we're re-showing (e.g. scrubbing
      // back and forth quickly).
      const pending = timers.get(frame!.epoch)
      if (pending) {
        window.clearTimeout(pending)
        timers.delete(frame!.epoch)
      }
      if (!map.hasLayer(layer)) layer.addTo(map)
      layer.bringToFront()
      const el = layer.getElement()
      if (freshlyCreated && el) el.classList.add('radar-image-enter')

      const applyOpacity = () => {
        if (cancelled) return
        layer.setOpacity(visible ? opacity : 0)
        el?.classList.remove('radar-image-enter')
      }
      // A layer just added at opacity 0 needs one committed frame before we
      // change it, or the browser collapses both writes and skips the fade.
      if (freshlyCreated) requestAnimationFrame(() => requestAnimationFrame(applyOpacity))
      else applyOpacity()

      const previousEpoch = activeEpochRef.current
      activeEpochRef.current = frame!.epoch
      if (previousEpoch !== null && previousEpoch !== frame!.epoch) {
        const previous = cache.get(previousEpoch)
        if (previous) {
          previous.setOpacity(0)
          previous.getElement()?.classList.add('radar-image-exit')
          const existingTimer = timers.get(previousEpoch)
          if (existingTimer) window.clearTimeout(existingTimer)
          const timerId = window.setTimeout(() => {
            if (map.hasLayer(previous)) map.removeLayer(previous)
            timers.delete(previousEpoch)
          }, FADE_MS)
          timers.set(previousEpoch, timerId)
        }
      }
    }

    if (existing) {
      show(existing, false)
      return
    }

    preloadImage(frame.url).then((ok) => {
      if (cancelled || !ok) return
      const layer = L.imageOverlay(frame.url, MSS_BOUNDS, {
        opacity: 0,
        zIndex: 20,
        className: 'radar-image',
      })
      cache.set(frame.epoch, layer)
      show(layer, true)
    })

    return () => {
      cancelled = true
    }
  }, [frame, map])

  useEffect(() => {
    if (!frame) return
    const layer = layersRef.current.get(frame.epoch)
    layer?.setOpacity(visible ? opacity : 0)
  }, [opacity, visible, frame])

  return null
}

// How many horizontal (latitude) bands the fallback nowcast slices the last
// frame into, so station-based drift can shear the island non-rigidly.
const NOWCAST_BANDS = 12
// Bands are drawn overlapping by this many source pixels so seams between
// them blend into a continuous edge.
const NOWCAST_BAND_OVERLAP_PX = 14

// A drift estimate for the fallback nowcast — per-station surface winds to
// interpolate band-by-band, or one velocity applied uniformly (the steering
// wind, which is the better estimate whenever it's available).
type DriftSource = { kind: 'stations'; stations: StationWind[] } | { kind: 'uniform'; u: number; v: number }

// Slices `image` into latitude bands over `bounds` and draws each shifted by
// the drift vector estimated for it.
function renderWindDriftFrame(
  canvas: HTMLCanvasElement,
  image: CanvasImageSource,
  w: number,
  h: number,
  bounds: L.LatLngBounds,
  drift: DriftSource | null,
  offsetMinutes: number,
) {
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, w, h)

  const hasDrift = drift && (drift.kind === 'uniform' || drift.stations.length > 0)
  if (!hasDrift || offsetMinutes <= 0) {
    ctx.drawImage(image, 0, 0, w, h)
    return
  }

  const sw = bounds.getSouthWest()
  const ne = bounds.getNorthEast()
  const degLat = ne.lat - sw.lat
  const degLon = ne.lng - sw.lng
  const centerLat = (sw.lat + ne.lat) / 2
  const pxPerDegLat = h / degLat
  const pxPerDegLon = w / degLon
  const bandHeight = h / NOWCAST_BANDS

  for (let band = 0; band < NOWCAST_BANDS; band++) {
    // Row 0 is the north edge of the image.
    const bandCenterLat = ne.lat - ((band + 0.5) / NOWCAST_BANDS) * degLat
    const { u, v } =
      drift.kind === 'stations' ? interpolateWindAt(drift.stations, bandCenterLat, (sw.lng + ne.lng) / 2) : drift
    const distanceKmU = u * (offsetMinutes / 60)
    const distanceKmV = v * (offsetMinutes / 60)
    const dxPx = (distanceKmU / KM_PER_DEG_LAT / Math.cos((centerLat * Math.PI) / 180)) * pxPerDegLon
    // Northward (+v) motion moves content toward smaller row indices (up).
    const dyPx = -(distanceKmV / KM_PER_DEG_LAT) * pxPerDegLat

    const srcY = Math.max(0, band * bandHeight - NOWCAST_BAND_OVERLAP_PX)
    const srcYEnd = Math.min(h, (band + 1) * bandHeight + NOWCAST_BAND_OVERLAP_PX)
    const srcH = srcYEnd - srcY
    ctx.drawImage(image, 0, srcY, w, srcH, dxPx, srcY + dyPx, w, srcH)
  }
}

// Fallback only: extrapolates the latest MSS image forward by wind drift
// when the motion-tracked layer can't run (MSS's images can't be read
// pixel-by-pixel without the same-origin proxy).
function LiquidNowcastLayer({
  baseFrame,
  drift,
  offsetMinutes,
  opacity,
  visible,
}: {
  baseFrame: RadarFrame | null
  drift: DriftSource | null
  offsetMinutes: number
  opacity: number
  visible: boolean
}) {
  const map = useMap()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const loadedUrlRef = useRef<string | null>(null)
  const [imgReady, setImgReady] = useState(0)

  // Create the canvas once and park it in the overlay pane, positioned exactly
  // like an L.ImageOverlay over MSS_BOUNDS.
  useEffect(() => {
    const canvas = L.DomUtil.create('canvas', 'radar-image') as HTMLCanvasElement
    canvas.style.position = 'absolute'
    canvas.style.pointerEvents = 'none'
    map.getPanes().overlayPane!.appendChild(canvas)
    canvasRef.current = canvas

    const reposition = () => {
      const topLeft = map.latLngToLayerPoint(MSS_BOUNDS.getNorthWest())
      const bottomRight = map.latLngToLayerPoint(MSS_BOUNDS.getSouthEast())
      const size = bottomRight.subtract(topLeft)
      canvas.style.width = `${size.x}px`
      canvas.style.height = `${size.y}px`
      L.DomUtil.setPosition(canvas, topLeft)
    }
    reposition()
    map.on('move zoom viewreset resize', reposition)

    return () => {
      map.off('move zoom viewreset resize', reposition)
      canvas.remove()
      canvasRef.current = null
    }
  }, [map])

  // Load the base frame image once per URL (a plain <img>, only ever
  // drawImage'd — never read back — so MSS's CORS policy doesn't matter).
  useEffect(() => {
    if (!baseFrame) return
    if (loadedUrlRef.current === baseFrame.url && imgRef.current) return
    let cancelled = false
    const img = new Image()
    img.onload = () => {
      if (cancelled) return
      imgRef.current = img
      loadedUrlRef.current = baseFrame.url
      setImgReady((r) => r + 1)
    }
    img.src = baseFrame.url
    return () => {
      cancelled = true
    }
  }, [baseFrame])

  useEffect(() => {
    const canvas = canvasRef.current
    const img = imgRef.current
    if (!canvas || !img || !img.naturalWidth) return
    if (!visible) return
    renderWindDriftFrame(canvas, img, img.naturalWidth, img.naturalHeight, MSS_BOUNDS, drift, offsetMinutes)
    canvas.style.filter = `blur(${(offsetMinutes / FUTURE_MINUTES) * 3}px)`
    canvas.style.opacity = String(opacity * nowcastFade(offsetMinutes))
  }, [imgReady, drift, offsetMinutes, opacity, visible])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    if (!visible) canvas.style.opacity = '0'
  }, [visible])

  return null
}

// Fallback only: RainViewer's radar tiles as a plain crossfading tile layer.
function RainviewerTileLayer({
  host,
  frame,
  opacity,
  visible,
  colorScheme = RAINVIEWER_TILE_STYLE,
}: {
  host: string | null
  frame: RainviewerFrame | null
  opacity: number
  visible: boolean
  colorScheme?: string
}) {
  const map = useMap()
  const layersRef = useRef<Map<string, L.TileLayer>>(new Map())
  const activeTimeRef = useRef<string | null>(null)
  const removalTimersRef = useRef<Map<string, number>>(new Map())

  useEffect(() => {
    const cache = layersRef.current
    const timers = removalTimersRef.current
    return () => {
      timers.forEach((id) => window.clearTimeout(id))
      timers.clear()
      cache.forEach((layer) => map.removeLayer(layer))
      cache.clear()
    }
  }, [map])

  useEffect(() => {
    const cache = layersRef.current
    const timers = removalTimersRef.current

    if (!host || !frame) {
      // Nothing to show (e.g. source/mode switched away) — fade out and drop
      // whatever was previously active instead of leaving it frozen on-screen.
      const previousKey = activeTimeRef.current
      activeTimeRef.current = null
      if (previousKey !== null) {
        const previous = cache.get(previousKey)
        if (previous) {
          previous.setOpacity(0)
          previous.getContainer()?.classList.add('radar-image-exit')
          const existingTimer = timers.get(previousKey)
          if (existingTimer) window.clearTimeout(existingTimer)
          const timerId = window.setTimeout(() => {
            if (map.hasLayer(previous)) map.removeLayer(previous)
            timers.delete(previousKey)
          }, FADE_MS)
          timers.set(previousKey, timerId)
        }
      }
      return
    }

    const cacheKey = `${frame.time}:${colorScheme}`
    let layer = cache.get(cacheKey)
    let freshlyCreated = false
    if (!layer) {
      const url = `${host}${frame.path}/${RAINVIEWER_TILE_SIZE}/{z}/{x}/{y}/${colorScheme}.png`
      layer = L.tileLayer(url, {
        opacity: 0,
        zIndex: 18,
        // Stays 256 even though the URL asks for 512px images: RainViewer's
        // /512/ endpoint is a @2x render of the *same* z/x/y grid, not a
        // coarser 512-tile scheme.
        tileSize: RAINVIEWER_GRID_SIZE,
        maxNativeZoom: RAINVIEWER_MAX_NATIVE_ZOOM,
        minNativeZoom: 2,
        className: 'radar-image',
      })
      cache.set(cacheKey, layer)
      freshlyCreated = true
    }

    const pending = timers.get(cacheKey)
    if (pending) {
      window.clearTimeout(pending)
      timers.delete(cacheKey)
    }
    if (!map.hasLayer(layer)) layer.addTo(map)
    layer.bringToFront()
    const container = layer.getContainer()
    if (freshlyCreated && container) container.classList.add('radar-image-enter')

    const applyOpacity = () => {
      layer!.setOpacity(visible ? opacity : 0)
      container?.classList.remove('radar-image-enter')
    }
    if (freshlyCreated) requestAnimationFrame(() => requestAnimationFrame(applyOpacity))
    else applyOpacity()

    const previousKey = activeTimeRef.current
    activeTimeRef.current = cacheKey
    if (previousKey !== null && previousKey !== cacheKey) {
      const previous = cache.get(previousKey)
      if (previous) {
        previous.setOpacity(0)
        previous.getContainer()?.classList.add('radar-image-exit')
        const existingTimer = timers.get(previousKey)
        if (existingTimer) window.clearTimeout(existingTimer)
        const timerId = window.setTimeout(() => {
          if (map.hasLayer(previous)) map.removeLayer(previous)
          timers.delete(previousKey)
        }, FADE_MS)
        timers.set(previousKey, timerId)
      }
    }
  }, [host, frame, colorScheme, map])

  useEffect(() => {
    if (!frame) return
    layersRef.current.get(`${frame.time}:${colorScheme}`)?.setOpacity(visible ? opacity : 0)
  }, [opacity, visible, frame, colorScheme])

  return null
}

// Toggles a live-updating "you are here" marker (blue dot + accuracy ring,
// matching standard map apps) instead of just a one-shot fly-to. First tap
// starts watching position and centers the map; a second tap stops tracking
// and removes the marker.
function MyLocationControl() {
  const map = useMap()
  const [status, setStatus] = useState<'idle' | 'locating' | 'active' | 'error'>('idle')
  const watchIdRef = useRef<number | null>(null)
  const markerRef = useRef<L.Marker | null>(null)
  const circleRef = useRef<L.Circle | null>(null)
  const hasCenteredRef = useRef(false)

  const clearMarkers = useCallback(() => {
    markerRef.current?.remove()
    markerRef.current = null
    circleRef.current?.remove()
    circleRef.current = null
  }, [])

  const updatePosition = useCallback(
    (pos: GeolocationPosition) => {
      const { latitude, longitude, accuracy } = pos.coords
      if (!markerRef.current) {
        const icon = L.divIcon({
          className: 'my-location-icon',
          html: '<div class="my-location-dot"></div>',
          iconSize: [18, 18],
          iconAnchor: [9, 9],
        })
        markerRef.current = L.marker([latitude, longitude], {
          icon,
          interactive: false,
          keyboard: false,
          zIndexOffset: 1000,
        }).addTo(map)
      } else {
        markerRef.current.setLatLng([latitude, longitude])
      }
      if (!circleRef.current) {
        circleRef.current = L.circle([latitude, longitude], {
          radius: accuracy,
          color: '#45d7ff',
          weight: 1,
          opacity: 0.4,
          fillColor: '#45d7ff',
          fillOpacity: 0.12,
          interactive: false,
        }).addTo(map)
      } else {
        circleRef.current.setLatLng([latitude, longitude])
        circleRef.current.setRadius(accuracy)
      }
      if (!hasCenteredRef.current) {
        hasCenteredRef.current = true
        map.flyTo([latitude, longitude], 14)
      }
    },
    [map],
  )

  const stopTracking = useCallback(() => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current)
      watchIdRef.current = null
    }
    clearMarkers()
    hasCenteredRef.current = false
    setStatus('idle')
  }, [clearMarkers])

  const toggleTracking = useCallback(() => {
    if (status === 'active' || status === 'locating') {
      stopTracking()
      return
    }
    if (!navigator.geolocation) {
      setStatus('error')
      return
    }
    setStatus('locating')
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        setStatus('active')
        updatePosition(pos)
      },
      () => setStatus('error'),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 },
    )
  }, [status, stopTracking, updatePosition])

  useEffect(
    () => () => {
      if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current)
    },
    [],
  )

  return (
    <button
      className={`tool-btn${status === 'active' ? ' active' : ''}`}
      onClick={toggleTracking}
      aria-label="Show my live location"
      aria-pressed={status === 'active'}
    >
      {status === 'locating' ? '…' : status === 'error' ? <IconWarning /> : <IconLocate />}
    </button>
  )
}

// Small drifting wind-direction arrows scattered across the map, matching the
// animated wind indicators in RainViewer's own app — each arrow points where
// the surface air is actually moving at that station right now.
function WindArrowLayer({ stations, visible }: { stations: StationWind[]; visible: boolean }) {
  const map = useMap()
  const groupRef = useRef<L.LayerGroup | null>(null)

  useEffect(() => {
    const group = L.layerGroup()
    groupRef.current = group
    return () => {
      group.clearLayers()
      groupRef.current = null
    }
  }, [])

  useEffect(() => {
    const group = groupRef.current
    if (!group) return
    if (visible) group.addTo(map)
    else group.remove()
  }, [map, visible])

  useEffect(() => {
    const group = groupRef.current
    if (!group) return
    group.clearLayers()
    for (const s of stations) {
      const bearingDeg = ((Math.atan2(s.u, s.v) * 180) / Math.PI + 360) % 360
      const speedKmh = Math.sqrt(s.u * s.u + s.v * s.v)
      if (speedKmh < 1) continue
      const icon = L.divIcon({
        className: 'wind-arrow-icon',
        html: `<div class="wind-arrow-wrap">
          <div class="wind-arrow" style="--bearing:${bearingDeg - 90}deg">➤</div>
          <div class="wind-speed-label">${Math.round(speedKmh)}</div>
        </div>`,
        iconSize: [40, 40],
        iconAnchor: [20, 11],
      })
      L.marker([s.lat, s.lon], { icon, interactive: false, keyboard: false }).addTo(group)
    }
  }, [stations])

  return null
}

type AirMetric = 'psi' | 'pm25'
type AirReading = { region: string; lat: number; lon: number; value: number }
const NO_READINGS: AirReading[] = []

// NEA's published bands. PSI is the 24-hour index, PM2.5 is the 1-hour
// concentration in µg/m³ (the one NEA uses for its hourly health advisory).
const AIR_BANDS: Record<AirMetric, { max: number; color: string }[]> = {
  psi: [
    { max: 50, color: '#3ddc84' },
    { max: 100, color: '#45a8ff' },
    { max: 200, color: '#ffb454' },
    { max: 300, color: '#ff4d5e' },
    { max: Infinity, color: '#b04bd6' },
  ],
  pm25: [
    { max: 55, color: '#3ddc84' },
    { max: 150, color: '#45a8ff' },
    { max: 250, color: '#ffb454' },
    { max: 350, color: '#ff4d5e' },
    { max: Infinity, color: '#b04bd6' },
  ],
}

function airColor(metric: AirMetric, value: number) {
  return (AIR_BANDS[metric].find((b) => value <= b.max) ?? AIR_BANDS[metric][0]).color
}

async function fetchAirReadings(metric: AirMetric): Promise<AirReading[]> {
  const res = await fetch(metric === 'psi' ? PSI_API : PM25_API)
  if (!res.ok) throw new Error(`air quality ${res.status}`)
  const json = await res.json()
  const regions: { name: string; labelLocation: { latitude: number; longitude: number } }[] =
    json?.data?.regionMetadata ?? []
  const items = json?.data?.items ?? []
  const readings = items[items.length - 1]?.readings?.[metric === 'psi' ? 'psi_twenty_four_hourly' : 'pm25_one_hourly']
  if (!readings) return []
  const out: AirReading[] = []
  for (const r of regions) {
    const value = readings[r.name]
    if (typeof value !== 'number' || r.name === 'national') continue
    out.push({ region: r.name, lat: r.labelLocation.latitude, lon: r.labelLocation.longitude, value })
  }
  return out
}

// Regional air quality badges (west/east/central/south/north), coloured by
// NEA band. Only fetches while a metric is selected.
function AirQualityLayer({ metric, refreshKey }: { metric: AirMetric | null; refreshKey: number }) {
  const map = useMap()
  const [data, setData] = useState<{ metric: AirMetric; readings: AirReading[] } | null>(null)
  const readings = data && data.metric === metric ? data.readings : NO_READINGS

  useEffect(() => {
    if (!metric) return
    let cancelled = false
    const load = () =>
      fetchAirReadings(metric)
        .then((r) => {
          if (!cancelled) setData({ metric, readings: r })
        })
        .catch(() => {})
    load()
    const id = window.setInterval(load, 10 * 60 * 1000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [metric, refreshKey])

  useEffect(() => {
    if (!metric) return
    const group = L.layerGroup().addTo(map)
    for (const r of readings) {
      const icon = L.divIcon({
        className: 'air-badge-icon',
        html: `<div class="air-badge" style="--air:${airColor(metric, r.value)}">${Math.round(r.value)}</div>`,
        iconSize: [44, 26],
        iconAnchor: [22, 13],
      })
      L.marker([r.lat, r.lon], { icon, interactive: false, keyboard: false }).addTo(group)
    }
    return () => {
      group.remove()
    }
  }, [map, metric, readings])

  return null
}

// Positron rendered by MapLibre inside Leaflet's tile pane (so radar and
// markers still stack above it). The canvas gets the .basemap-tile class,
// whose invert + hue-rotate filter turns the light style into the app's dark
// theme while keeping water blue and parks green.
function VectorBasemap() {
  const map = useMap()
  useEffect(() => {
    const layer = maplibreGL({ style: BASEMAP_STYLE, className: 'basemap-tile' } as Parameters<typeof maplibreGL>[0])
    layer.addTo(map)
    return () => {
      layer.remove()
    }
  }, [map])
  return null
}

function MapResizeHandler() {
  const map = useMap()
  useEffect(() => {
    const container = map.getContainer()
    const invalidate = () => map.invalidateSize()
    const observer = new ResizeObserver(() => invalidate())
    observer.observe(container)
    window.addEventListener('orientationchange', invalidate)
    // iOS Safari settles its safe-area/status-bar insets a moment after first
    // paint (especially on a cold PWA launch), which can leave Leaflet's
    // cached container size a few px short at the top — a plain resize event
    // doesn't always fire for that, so also watch the Visual Viewport API
    // (the authoritative signal for this on iOS) and re-check a couple more
    // times as a safety net rather than trusting one 300ms timer.
    window.visualViewport?.addEventListener('resize', invalidate)
    const settleTimers = [100, 300, 800, 1500].map((ms) => window.setTimeout(invalidate, ms))
    return () => {
      observer.disconnect()
      window.removeEventListener('orientationchange', invalidate)
      window.visualViewport?.removeEventListener('resize', invalidate)
      settleTimers.forEach((t) => window.clearTimeout(t))
    }
  }, [map])
  return null
}

type Confidence = 'high' | 'medium' | 'low'

// How far to trust an extrapolated frame. Radar extrapolation skill for
// tropical convection falls off fast: roughly useful to ~30 min, indicative
// to ~1h, and little better than a guess beyond. Anything not tracked from
// the radar itself is downgraded a step, and the SG image only covers ~60km,
// so rain arriving after ~45 min usually hasn't entered it yet.
function forecastConfidence(leadMin: number, motion: MotionSource, smallDomain: boolean): Confidence {
  let score = leadMin <= 30 ? 2 : leadMin <= 60 ? 1 : 0
  if (motion !== 'radar') score--
  if (smallDomain && leadMin > 45) score = Math.min(score, 0)
  return score >= 2 ? 'high' : score === 1 ? 'medium' : 'low'
}

const PAST_MINUTES = 60
const FUTURE_MINUTES = 120
const STEP_MINUTES = 5
// Fallback guess used only for the brief moment before the first real probe
// (below) resolves — after that, "now" is whatever MSS frame actually loaded.
const LIVE_SAFETY_BUFFER_MINUTES = 5
// Playback speed for the continuous glide, so a full sweep of the timeline
// takes about 25s.
const PLAYBACK_MIN_PER_SEC = (PAST_MINUTES + FUTURE_MINUTES) / 25

export default function RadarMap() {
  const [nowAnchor, setNowAnchor] = useState(() =>
    floorToSgFiveMin(Date.now() - LIVE_SAFETY_BUFFER_MINUTES * 60 * 1000),
  )
  const [windField, setWindField] = useState<WindField | null>(null)
  const [steering, setSteering] = useState<SteeringWind | null>(null)
  const [rainviewer, setRainviewer] = useState<RainviewerData | null>(null)
  const [offsetMinutes, setOffsetMinutes] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [playbackRate, setPlaybackRate] = useState(1)
  // Fixed rather than user-adjustable — one less control cluttering the screen.
  // GLOBAL matches the value RainViewer's own client ships with; MSS keeps the
  // slightly stronger value its thinner composite needs to stay readable.
  const [radarSource, setRadarSource] = useState<RadarSource>('mss')
  const opacity = radarSource === 'rainviewer' ? RAINVIEWER_LAYER_OPACITY : 0.92
  const [windVisible, setWindVisible] = useState(true)
  const [airMetric, setAirMetric] = useState<AirMetric | null>(null)
  const [legendOpen, setLegendOpen] = useState(false)
  const [mssFlow, setMssFlow] = useState<FlowStatus | null>(null)
  const [rvFlow, setRvFlow] = useState<FlowStatus | null>(null)
  // Bumping this re-runs every live-data effect below immediately, for the
  // manual refresh button — on top of their normal polling intervals.
  const [refreshKey, setRefreshKey] = useState(0)
  const [refreshing, setRefreshing] = useState(false)

  const handleRefresh = useCallback(() => {
    setRefreshing(true)
    setRefreshKey((k) => k + 1)
    window.setTimeout(() => setRefreshing(false), 900)
  }, [])

  // Actually probes for the latest MSS frame that exists (instead of a fixed
  // publish-latency guess). Re-probes on an interval and whenever the tab
  // regains focus, so returning from background doesn't leave a stale frame.
  useEffect(() => {
    let cancelled = false
    async function sync() {
      const epoch = await probeLatestMssEpoch()
      if (cancelled || epoch === null) return
      setNowAnchor(epoch)
    }
    sync()
    const interval = window.setInterval(sync, 2 * 60 * 1000)
    const onVisible = () => {
      if (document.visibilityState === 'visible') sync()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refreshKey])

  useEffect(() => {
    let cancelled = false
    async function load() {
      const v = await fetchWindField()
      if (!cancelled && v) setWindField(v)
    }
    load()
    const interval = window.setInterval(load, 10 * 60 * 1000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [refreshKey])

  useEffect(() => {
    let cancelled = false
    async function load() {
      const s = await fetchSteeringWind()
      if (!cancelled && s) setSteering(s)
    }
    load()
    const interval = window.setInterval(load, 30 * 60 * 1000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [refreshKey])

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch(RAINVIEWER_API)
        if (!res.ok) return
        const json = await res.json()
        if (!cancelled) setRainviewer({ host: json.host, past: json.radar?.past ?? [] })
      } catch {
        // Silently skip — the SG source keeps working without it.
      }
    }
    load()
    const interval = window.setInterval(load, 5 * 60 * 1000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [refreshKey])

  const pastFrames: RadarFrame[] = useMemo(() => {
    const frames: RadarFrame[] = []
    const seen = new Set<number>()
    for (let m = PAST_MINUTES; m >= 0; m -= STEP_MINUTES) {
      const epoch = floorToSgFiveMin(nowAnchor - m * 60 * 1000)
      if (seen.has(epoch)) continue
      seen.add(epoch)
      frames.push({ epoch, url: mssImageUrl(epoch) })
    }
    return frames
  }, [nowAnchor])

  const mssKeyframes: FlowKeyframe[] = useMemo(
    () => pastFrames.map((f) => ({ key: String(f.epoch), time: f.epoch })),
    [pastFrames],
  )

  // RainViewer scans every 10 min; keep one scan older than the timeline's
  // start so the earliest minutes still have a pair to interpolate within.
  const rvKeyframes: FlowKeyframe[] = useMemo(() => {
    if (!rainviewer) return []
    const cutoff = nowAnchor - (PAST_MINUTES + 10) * 60 * 1000
    return rainviewer.past
      .filter((f) => f.time * 1000 >= cutoff)
      .map((f) => ({ key: f.path, time: f.time * 1000 }))
  }, [rainviewer, nowAnchor])

  const rvHost = rainviewer?.host ?? null
  const loadRainviewerFrame = useCallback(
    (path: string) => (rvHost ? stitchRainviewerFrame(rvHost, path) : Promise.resolve(null)),
    [rvHost],
  )

  const isFuture = offsetMinutes > 0
  // Whole-minute snap of the continuously-gliding offset, used anywhere the
  // raw float would render an ugly fraction (badge text, the LIVE check).
  const roundedOffset = Math.round(offsetMinutes)
  const displayEpoch = nowAnchor + offsetMinutes * 60 * 1000

  const currentFrame: RadarFrame | null = useMemo(() => {
    if (pastFrames.length === 0) return null
    let closest = pastFrames[0]
    let bestDiff = Infinity
    for (const f of pastFrames) {
      const diff = Math.abs(f.epoch - displayEpoch)
      if (diff < bestDiff) {
        bestDiff = diff
        closest = f
      }
    }
    return closest
  }, [pastFrames, displayEpoch])

  const liveFrame = pastFrames.length > 0 ? pastFrames[pastFrames.length - 1] : null

  const fallbackRainviewerFrame: RainviewerFrame | null = useMemo(() => {
    if (!rainviewer || rainviewer.past.length === 0) return null
    return closestRainviewerFrame(rainviewer.past, displayEpoch)
  }, [rainviewer, displayEpoch])

  const mssFlowReady = !!mssFlow?.ready
  const rvFlowReady = !!rvFlow?.ready

  // Fallback MSS drift: the steering wind if we have it (a far better proxy
  // for storm motion than surface wind), otherwise per-station surface wind.
  const fallbackDrift = useMemo<DriftSource | null>(() => {
    if (steering) return { kind: 'uniform', u: steering.u, v: steering.v }
    if (windField) return { kind: 'stations', stations: windField.stations }
    return null
  }, [steering, windField])

  // What the info line under the time says: where this frame comes from, and
  // for anything extrapolated, how the motion was measured and how far to
  // trust it.
  const note = useMemo(() => {
    const flow = radarSource === 'mss' ? mssFlow : rvFlow
    const flowReady = !!flow?.ready
    const latestScan = flowReady
      ? flow!.latestScan!
      : radarSource === 'mss'
        ? nowAnchor
        : (rainviewer?.past.at(-1)?.time ?? 0) * 1000
    const leadMin = latestScan ? (displayEpoch - latestScan) / 60_000 : 0
    const sourceName = radarSource === 'mss' ? 'MSS radar' : 'RainViewer radar'
    if (leadMin <= 1) {
      return {
        text: `${sourceName} · observed${flowReady && offsetMinutes < 0 ? ', smoothed between scans' : ''}`,
        confidence: null as Confidence | null,
      }
    }
    let motion: MotionSource
    let speed = 0
    let bearing = 0
    if (flowReady) {
      motion = flow!.motionSource
      speed = flow!.speedKmh
      bearing = flow!.towardBearingDeg
    } else if (steering) {
      motion = 'steering'
      speed = Math.hypot(steering.u, steering.v)
      bearing = ((Math.atan2(steering.u, steering.v) * 180) / Math.PI + 360) % 360
    } else {
      motion = 'none'
    }
    const movement =
      motion === 'none'
        ? 'no motion estimate'
        : speed < 3
          ? 'rain near-stationary'
          : `moving ${compassPoint(bearing)} ${Math.round(speed)} km/h`
    const how = motion === 'radar' ? 'radar-tracked' : motion === 'steering' ? 'from upper wind' : ''
    const prefix = offsetMinutes <= 0 ? `Last scan ${formatTime(latestScan)} · ` : 'Forecast · '
    return {
      text: `${prefix}${movement}${how ? ` (${how})` : ''}`,
      confidence: forecastConfidence(leadMin, motion, radarSource === 'mss'),
    }
  }, [radarSource, mssFlow, rvFlow, nowAnchor, rainviewer, displayEpoch, offsetMinutes, steering])

  // Glides offsetMinutes continuously via rAF rather than jumping in fixed
  // 5-min steps; the flow layer synthesises the radar for every in-between
  // instant, so the rain itself moves continuously too.
  useEffect(() => {
    if (!playing) return
    let raf: number
    let last: number | null = null
    const tick = (now: number) => {
      if (last === null) last = now
      const dtSeconds = (now - last) / 1000
      last = now
      setOffsetMinutes((m) => {
        const next = m + PLAYBACK_MIN_PER_SEC * playbackRate * dtSeconds
        return next > FUTURE_MINUTES ? -PAST_MINUTES : next
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, playbackRate])

  const togglePlay = useCallback(() => setPlaying((p) => !p), [])
  const cyclePlaybackRate = useCallback(() => setPlaybackRate((r) => (r === 1 ? 2 : r === 2 ? 3 : 1)), [])

  return (
    <div className="radar-app">
      <div className="map-wrap">
        <MapContainer
          center={SINGAPORE}
          zoom={10}
          minZoom={9}
          maxZoom={15}
          style={{ height: '100%', width: '100%' }}
          zoomControl={false}
          attributionControl={false}
        >
          <VectorBasemap />
          <FlowRadarLayer
            enabled={radarSource === 'mss'}
            frames={mssKeyframes}
            loadFrame={loadMssFrame}
            bounds={MSS_BOUNDS}
            palette={MSS_PALETTE}
            config={MSS_FLOW_CONFIG}
            targetTime={displayEpoch}
            steering={steering}
            opacity={opacity}
            visible={radarSource === 'mss'}
            onStatus={setMssFlow}
          />
          <FlowRadarLayer
            enabled={radarSource === 'rainviewer'}
            frames={rvKeyframes}
            loadFrame={loadRainviewerFrame}
            bounds={RAINVIEWER_WINDOW_BOUNDS}
            palette={RAINVIEWER_PALETTE}
            config={RAINVIEWER_FLOW_CONFIG}
            targetTime={displayEpoch}
            steering={steering}
            opacity={opacity}
            visible={radarSource === 'rainviewer'}
            onStatus={setRvFlow}
          />
          {/* Fallbacks, only shown while (or if) the motion-tracked layer
              above can't render for the selected source. */}
          <RadarImageLayer
            frame={currentFrame}
            opacity={opacity}
            visible={!isFuture && radarSource === 'mss' && !mssFlowReady}
          />
          <LiquidNowcastLayer
            baseFrame={liveFrame}
            drift={fallbackDrift}
            offsetMinutes={offsetMinutes}
            opacity={opacity}
            visible={isFuture && radarSource === 'mss' && !mssFlowReady}
          />
          <RainviewerTileLayer
            host={rvHost}
            frame={fallbackRainviewerFrame}
            opacity={opacity}
            visible={radarSource === 'rainviewer' && !rvFlowReady}
          />
          <WindArrowLayer stations={windField?.stations ?? []} visible={windVisible} />
          <AirQualityLayer metric={airMetric} refreshKey={refreshKey} />
          <MapResizeHandler />
          <div className="map-tool-stack">
            <MyLocationControl />
            <button
              className={`tool-btn${windVisible ? ' active' : ''}`}
              onClick={() => setWindVisible((v) => !v)}
              aria-label="Toggle wind overlay"
              aria-pressed={windVisible}
            >
              <IconWind />
            </button>
            <button
              className={`tool-btn tool-btn-text${airMetric === 'psi' ? ' active' : ''}`}
              onClick={() => setAirMetric((m) => (m === 'psi' ? null : 'psi'))}
              aria-label="Toggle 24-hour PSI"
              aria-pressed={airMetric === 'psi'}
            >
              <span>24hr</span>
              <span>PSI</span>
            </button>
            <button
              className={`tool-btn tool-btn-text${airMetric === 'pm25' ? ' active' : ''}`}
              onClick={() => setAirMetric((m) => (m === 'pm25' ? null : 'pm25'))}
              aria-label="Toggle 1-hour PM2.5"
              aria-pressed={airMetric === 'pm25'}
            >
              <span>PM</span>
              <span>2.5</span>
            </button>
          </div>
        </MapContainer>

        {/* Required credit for the basemap and data sources — kept small and
            out of the way of the floating controls above it, in the thin
            strip beneath them rather than Leaflet's default clunky box. */}
        <div className="map-attribution">
          <a href="https://openfreemap.org/" target="_blank" rel="noopener noreferrer">
            OpenFreeMap
          </a>
          {' · '}
          <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener noreferrer">
            OpenMapTiles
          </a>
          {' · '}
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">
            OpenStreetMap
          </a>
          {' · '}
          <a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">
            Open-Meteo
          </a>
        </div>

        <div className={`source-tray${radarSource === 'rainviewer' ? ' shifted' : ''}`}>
          <span className="source-tray-thumb" />
          <button
            className={`source-tray-btn${radarSource === 'mss' ? ' active' : ''}`}
            onClick={() => setRadarSource('mss')}
          >
            SG
          </button>
          <button
            className={`source-tray-btn${radarSource === 'rainviewer' ? ' active' : ''}`}
            onClick={() => setRadarSource('rainviewer')}
          >
            GLOBAL
          </button>
        </div>

        {/* A single persistent element (not two swapped-in/out buttons) so
            the collapsed<->expanded size change and icon<->scale cross-fade
            can actually transition smoothly instead of popping. */}
        <button
          className={`legend${legendOpen ? ' open' : ''}`}
          onClick={() => setLegendOpen((v) => !v)}
          aria-expanded={legendOpen}
          aria-label={legendOpen ? 'Collapse rain intensity legend' : 'Expand rain intensity legend'}
        >
          <span className="legend-swatch">
            <IconInfo />
          </span>
          <div className="legend-body">
            <div
              className="legend-gradient"
              style={{
                background: `linear-gradient(to top, ${(radarSource === 'rainviewer' ? RAINVIEWER_LEGEND : MSS_LEGEND).join(',')})`,
              }}
            />
            <div className="legend-ticks">
              <span>Violent</span>
              <span>Heavy</span>
              <span>Moderate</span>
              <span>Light</span>
            </div>
          </div>
        </button>

        {/* Floating "island" card rather than an in-flow footer, so the map
            stretches to the true bottom edge behind it instead of being
            squeezed by a docked panel. */}
        <div className="radar-controls">
          <div className="frame-time-row">
            <span className="range-edge">−{Math.round(PAST_MINUTES / 60)}h</span>
            <button
              className="frame-time-center"
              onClick={() => {
                setPlaying(false)
                setOffsetMinutes(0)
              }}
              disabled={roundedOffset === 0}
              aria-label="Jump to now"
            >
              <span className="frame-time">{formatTime(displayEpoch)}</span>
              {roundedOffset === 0 ? (
                <span className="live-badge">LIVE</span>
              ) : (
                <span className="offset-badge">
                  {roundedOffset > 0 ? '+' : '−'}
                  {(() => {
                    const abs = Math.abs(roundedOffset)
                    const hrs = Math.floor(abs / 60)
                    const mins = abs % 60
                    if (hrs === 0) return `${mins}m`
                    return mins === 0 ? `${hrs}h` : `${hrs}h ${mins}m`
                  })()}
                </span>
              )}
            </button>
            <span className="range-edge">+{Math.round(FUTURE_MINUTES / 60)}h</span>
          </div>

          <div className="radar-note">
            <span className="radar-note-text">{note.text}</span>
            {note.confidence && (
              <span className={`radar-note-confidence ${note.confidence}`}>{note.confidence} confidence</span>
            )}
          </div>

          <div className="controls-row">
            <button className="play-btn" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>
              {playing ? <IconPause size={16} /> : <IconPlay size={16} />}
            </button>

            <button
              className="speed-btn"
              onClick={cyclePlaybackRate}
              aria-label={`Playback speed ${playbackRate}x, tap to change`}
            >
              {playbackRate}x
            </button>

            <div className="timeline-wrap">
              <input
                type="range"
                className="timeline"
                min={-PAST_MINUTES}
                max={FUTURE_MINUTES}
                // 1-minute resolution: the layer renders any instant, so
                // scrubbing glides instead of snapping between 5-min scans.
                step={1}
                value={offsetMinutes}
                onChange={(e) => {
                  const next = Number(e.target.value)
                  // Still one haptic tap per 5-min dot the thumb passes.
                  if (Math.floor(next / STEP_MINUTES) !== Math.floor(offsetMinutes / STEP_MINUTES)) {
                    triggerTickHaptic()
                  }
                  setPlaying(false)
                  setOffsetMinutes(next)
                }}
              />
            </div>

            <button
              className={`refresh-btn${refreshing ? ' spinning' : ''}`}
              onClick={handleRefresh}
              aria-label="Refresh live data"
            >
              <IconRefresh size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
