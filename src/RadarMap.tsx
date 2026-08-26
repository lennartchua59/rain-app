import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { MapContainer, TileLayer, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import './RadarMap.css'

const SINGAPORE: [number, number] = [1.3521, 103.8198]

// Bounding box of MSS's own rain-area radar composite (same source their site embeds).
const MSS_SOUTH_WEST: L.LatLngTuple = [1.156, 103.565]
const MSS_NORTH_EAST: L.LatLngTuple = [1.475, 104.13]
const MSS_BOUNDS = L.latLngBounds(MSS_SOUTH_WEST, MSS_NORTH_EAST)

const WIND_SPEED_API = 'https://api-open.data.gov.sg/v2/real-time/api/wind-speed'
const WIND_DIRECTION_API = 'https://api-open.data.gov.sg/v2/real-time/api/wind-direction'
const RAINVIEWER_API = 'https://api.rainviewer.com/public/weather-maps.json'
const KNOTS_TO_KMH = 1.852
const KM_PER_DEG_LAT = 111
// RainViewer's public composite only has native imagery up to this zoom for this
// region; requesting deeper zooms returns a "Zoom Level Not Supported" placeholder.
const RAINVIEWER_MAX_NATIVE_ZOOM = 7
// A published nowcast frame is only trusted for offsets within this many
// minutes of its own timestamp, so we don't stretch a 10-min-interval frame
// too far. RainViewer's frames normally land on a 10-min grid, so any point
// on the timeline is at most 5 min from the nearest one — this tolerance is
// comfortably above that, so real published data always wins over our own
// echo-motion/wind extrapolation whenever RainViewer has actually published
// something for that lead time; a slightly irregular publish schedule is the
// only thing the extra margin is guarding against.
const RAINVIEWER_MATCH_TOLERANCE_MIN = 8
// Crossfade duration for swapping radar/satellite frames — must match the CSS
// `transition: opacity` duration on .radar-image so the JS removal timer doesn't
// cut a layer before its fade-out finishes. Slightly longer than a hard cut so
// consecutive 5-min frames read as one continuous, flowing motion.
const FADE_MS = 600

// Slippy-map tile math (standard Web Mercator), used to stitch RainViewer's
// tiled mosaic into one raster we can wind-shift the same way as MSS's single
// composite image — RainViewer only ever gives us a tile grid, not one image.
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

// Extra tiles of margin fetched around the SG/JB bounding box, so wind-shifting
// a band never slides content far enough to reveal the stitched raster's edge.
const RAINVIEWER_TILE_PADDING = 1
const RV_MIN_TILE_X = lonToTileX(MSS_SOUTH_WEST[1], RAINVIEWER_MAX_NATIVE_ZOOM) - RAINVIEWER_TILE_PADDING
const RV_MAX_TILE_X = lonToTileX(MSS_NORTH_EAST[1], RAINVIEWER_MAX_NATIVE_ZOOM) + RAINVIEWER_TILE_PADDING
const RV_MIN_TILE_Y = latToTileY(MSS_NORTH_EAST[0], RAINVIEWER_MAX_NATIVE_ZOOM) - RAINVIEWER_TILE_PADDING
const RV_MAX_TILE_Y = latToTileY(MSS_SOUTH_WEST[0], RAINVIEWER_MAX_NATIVE_ZOOM) + RAINVIEWER_TILE_PADDING
const RAINVIEWER_STITCH_BOUNDS = L.latLngBounds(
  [tileYToLat(RV_MAX_TILE_Y + 1, RAINVIEWER_MAX_NATIVE_ZOOM), tileXToLon(RV_MIN_TILE_X, RAINVIEWER_MAX_NATIVE_ZOOM)],
  [tileYToLat(RV_MIN_TILE_Y, RAINVIEWER_MAX_NATIVE_ZOOM), tileXToLon(RV_MAX_TILE_X + 1, RAINVIEWER_MAX_NATIVE_ZOOM)],
)

// MSS's own color ramp for the rain-area product, light -> heavy.
const INTENSITY_COLORS = [
  '#40FFFD',
  '#32D0D2',
  '#1B8742',
  '#38EF46',
  '#FEFB63',
  '#FDD74A',
  '#FAA23D',
  '#F94C2D',
  '#DD1423',
]

// Approximation of RainViewer's own "colorScheme 4" (their default web/app
// palette) ramp, light -> heavy, for the legend when the RainViewer source is
// selected — their tile colors don't come from a published stop list, so this
// is read off their rendered tiles rather than an official spec.
const RAINVIEWER_INTENSITY_COLORS = [
  '#5AD0F0',
  '#3B9EE5',
  '#3BB143',
  '#8FD13B',
  '#F2E23B',
  '#F2A93B',
  '#F2673B',
  '#D63B3B',
  '#9B2FAE',
]

// A single frame from RainViewer's own radar/satellite mosaic, matched by
// closest published timestamp to the requested epoch.
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

// The regional average (for the banner text) plus each station's own reading, so
// the nowcast layer can drift different parts of Singapore at different real
// wind speeds/directions instead of sliding the whole island as one rigid block.
type WindField = { average: WindVector; stations: StationWind[] }

type RainviewerFrame = { time: number; path: string }
type RainviewerData = {
  host: string
  past: RainviewerFrame[]
  nowcast: RainviewerFrame[]
}

// Which radar mosaic to render for past/live frames — MSS's own official
// Singapore composite, or RainViewer's global stitched-radar mosaic (the same
// source their web/app clients render).
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

function mssImageUrl(epoch: number) {
  const { y, mo, da, h, mi } = sgFields(epoch)
  const dt = `${y}${pad(mo)}${pad(da)}${pad(h)}${pad(mi)}`
  return `https://www.weather.gov.sg/files/rainarea/50km/v2/dpsri_70km_${dt}0000dBR.dpsri.png`
}

function formatTime(epoch: number) {
  return new Date(epoch).toLocaleTimeString('en-SG', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Asia/Singapore',
  })
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

// Fetches every station's own wind vector (not just one regional average) so the
// nowcast layer can drift different parts of the island at different real
// speeds/bearings — genuine differential wind shear instead of one rigid slide.
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

// Inverse-distance-weighted blend of nearby stations' wind vectors at one point,
// so each band of the nowcast image drifts by the real wind actually measured
// near it instead of one island-wide average.
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

// Georeferenced, single-image radar overlay for one point in time. Crossfades by
// preloading the next frame fully before swapping — the outgoing frame fades OUT
// at the same time the incoming one fades IN (both held on the map together for
// FADE_MS), so consecutive 5-min frames blend into one continuous motion instead
// of a hard cut.
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

// How many horizontal (latitude) bands the last live frame is sliced into for
// the nowcast — each band drifts by the real wind measured nearest to it, so
// the island shears non-rigidly instead of sliding as one flat block.
const NOWCAST_BANDS = 12
// Bands are drawn overlapping by this many source pixels and the composite is
// then blurred, so seams between bands blend into a continuous, fluid edge
// instead of visible strip boundaries.
const NOWCAST_BAND_OVERLAP_PX = 14

// A drift estimate to extrapolate a radar frame forward with — either a set of
// per-station wind vectors to interpolate band-by-band (MSS, where real wind
// observations are available but not frame-to-frame motion), or a single
// already-resolved velocity applied uniformly (RainViewer, where we instead
// measure actual echo motion between two frames — see estimateEchoMotion).
type DriftSource = { kind: 'stations'; stations: StationWind[] } | { kind: 'uniform'; u: number; v: number }

// Shared band-shift compositor behind both wind-drift nowcast layers below:
// slices `image` into latitude bands over `bounds` and draws each shifted by
// the drift vector estimated for it, so different parts of the island can
// drift at different speeds/bearings — genuine differential shear rather than
// one rigid slide of the whole frame (uniform drift sources shift every band
// identically, which collapses to a plain single-vector slide).
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
    // Row 0 is the north edge of the image; bounds.getNorthWest() is north.
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

function uniformDriftFromStationAverage(windField: WindField): DriftSource {
  const rad = (windField.average.towardBearingDeg * Math.PI) / 180
  return {
    kind: 'uniform',
    u: windField.average.speedKmh * Math.sin(rad),
    v: windField.average.speedKmh * Math.cos(rad),
  }
}

// Resolution of the downsampled grid the echo-motion search runs on, and how
// far (in that grid's pixels) it searches in each direction. Coarser than the
// native tile resolution on purpose — keeps the O(size^2 * radius^2) search
// fast — with a parabolic sub-pixel refinement afterward to claw back
// precision the downsampling would otherwise lose.
const MOTION_GRID_SIZE = 96
const MOTION_SEARCH_RADIUS = 10
// The best integer shift must beat "no motion at all" by at least this
// fraction of the zero-shift error before it's trusted — guards against
// chasing noise when the frame is mostly empty (no coherent rain pattern) or
// truly hasn't moved.
const MOTION_CONFIDENCE_MARGIN = 0.02

// Downsamples a canvas to a small grayscale intensity grid for the motion
// search below. Transparent pixels (no rain) are treated as zero intensity.
function toMotionGrid(source: CanvasImageSource, size: number): Float32Array | null {
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  const ctx = c.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(source, 0, 0, size, size)
  let data: Uint8ClampedArray
  try {
    data = ctx.getImageData(0, 0, size, size).data
  } catch {
    // Tainted canvas — shouldn't happen since RainViewer's tiles send CORS
    // headers, but fail closed rather than throw if that ever changes.
    return null
  }
  const out = new Float32Array(size * size)
  for (let i = 0; i < size * size; i++) {
    const a = data[i * 4 + 3]
    out[i] = a < 10 ? 0 : (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3
  }
  return out
}

// Finds the pixel translation that best aligns `prev` onto `curr` by
// minimizing mean squared difference over their overlap — a plain,
// dependency-free stand-in for optical flow. Good enough to pull out one
// dominant storm-motion vector at this resolution, not a full flow field.
function estimateGridShift(
  prev: Float32Array,
  curr: Float32Array,
  size: number,
  radius: number,
): { dx: number; dy: number } | null {
  const span = radius * 2 + 1
  const errGrid = new Float32Array(span * span).fill(Infinity)
  let bestErr = Infinity
  let bestI = radius
  let bestJ = radius

  for (let j = 0; j < span; j++) {
    const dy = j - radius
    for (let i = 0; i < span; i++) {
      const dx = i - radius
      let sum = 0
      let count = 0
      for (let y = 0; y < size; y++) {
        const py = y - dy
        if (py < 0 || py >= size) continue
        const rowOff = y * size
        const prowOff = py * size
        for (let x = 0; x < size; x++) {
          const px = x - dx
          if (px < 0 || px >= size) continue
          const diff = curr[rowOff + x] - prev[prowOff + px]
          sum += diff * diff
          count++
        }
      }
      if (count < size * size * 0.5) continue
      const err = sum / count
      errGrid[j * span + i] = err
      if (err < bestErr) {
        bestErr = err
        bestI = i
        bestJ = j
      }
    }
  }

  const zeroErr = errGrid[radius * span + radius]
  if (!Number.isFinite(bestErr) || !Number.isFinite(zeroErr) || zeroErr === 0) return null
  if ((zeroErr - bestErr) / zeroErr < MOTION_CONFIDENCE_MARGIN) return null

  // Parabolic sub-pixel refinement using the immediate neighbors of the best
  // integer shift, independently in each axis.
  let subI = bestI
  let subJ = bestJ
  if (bestI > 0 && bestI < span - 1) {
    const eL = errGrid[bestJ * span + (bestI - 1)]
    const eR = errGrid[bestJ * span + (bestI + 1)]
    const denom = eL - 2 * bestErr + eR
    if (Number.isFinite(eL) && Number.isFinite(eR) && denom !== 0) subI = bestI + (0.5 * (eL - eR)) / denom
  }
  if (bestJ > 0 && bestJ < span - 1) {
    const eT = errGrid[(bestJ - 1) * span + bestI]
    const eB = errGrid[(bestJ + 1) * span + bestI]
    const denom = eT - 2 * bestErr + eB
    if (Number.isFinite(eT) && Number.isFinite(eB) && denom !== 0) subJ = bestJ + (0.5 * (eT - eB)) / denom
  }

  return { dx: subI - radius, dy: subJ - radius }
}

// Converts a pixel displacement measured between two frames spaced
// `dtMinutes` apart into an eastward/northward km/h velocity, inverting the
// same geometry renderWindDriftFrame uses to turn a velocity into a shift.
function pixelShiftToVelocity(
  dxPx: number,
  dyPx: number,
  bounds: L.LatLngBounds,
  w: number,
  h: number,
  dtMinutes: number,
): { u: number; v: number } {
  const sw = bounds.getSouthWest()
  const ne = bounds.getNorthEast()
  const degLat = ne.lat - sw.lat
  const degLon = ne.lng - sw.lng
  const centerLat = (sw.lat + ne.lat) / 2
  const pxPerDegLat = h / degLat
  const pxPerDegLon = w / degLon
  const hours = dtMinutes / 60
  const u = (dxPx / pxPerDegLon) * KM_PER_DEG_LAT * Math.cos((centerLat * Math.PI) / 180) * (1 / hours)
  const v = (-dyPx / pxPerDegLat) * KM_PER_DEG_LAT * (1 / hours)
  return { u, v }
}

// Bilinear-samples a square grid at fractional coordinates; null outside it.
function sampleGridBilinear(grid: Float32Array, size: number, x: number, y: number): number | null {
  if (x < 0 || y < 0 || x > size - 1 || y > size - 1) return null
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = Math.min(x0 + 1, size - 1)
  const y1 = Math.min(y0 + 1, size - 1)
  const fx = x - x0
  const fy = y - y0
  const v00 = grid[y0 * size + x0]
  const v10 = grid[y0 * size + x1]
  const v01 = grid[y1 * size + x0]
  const v11 = grid[y1 * size + x1]
  return v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy
}

// Below this grayscale intensity a cell is treated as "no rain" — guards the
// growth-ratio measurement below against amplifying sensor/compression noise
// in near-empty areas, where a tiny prevVal would otherwise blow the ratio up.
const GROWTH_SIGNAL_FLOOR = 8
// Per-interval growth ratio is clamped to this range before extrapolation —
// a single frame-to-frame comparison is noisy, so this keeps one outlier
// interval from producing an absurd forward extrapolation.
const GROWTH_RATIO_MIN = 0.3
const GROWTH_RATIO_MAX = 3
// Final extrapolated growth factor (ratio raised to the lead-time power) is
// clamped to this range — real cells don't sustain exponential growth for
// two hours, and this keeps far-future frames from blowing out or vanishing.
const GROWTH_FACTOR_MIN = 0.15
const GROWTH_FACTOR_MAX = 4
// Caps how many "intervals" the growth ratio gets extrapolated across, so a
// two-hour lead time (potentially 12+ ten-minute intervals) doesn't compound
// a noisy per-interval ratio into an extreme value before the factor clamp
// above even applies.
const GROWTH_POWER_CAP = 6

// A per-cell intensity growth/decay map, in the same low-res grid used for
// motion estimation: growthGrid[i] is how much cell i's intensity multiplied
// between the two source frames, after compensating for the frame's overall
// motion (so a storm that simply moved isn't misread as decaying where it
// used to be and growing where it now is).
function buildGrowthGrid(
  prevGrid: Float32Array,
  currGrid: Float32Array,
  size: number,
  shiftDx: number,
  shiftDy: number,
): Float32Array {
  const out = new Float32Array(size * size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x
      const prevVal = sampleGridBilinear(prevGrid, size, x - shiftDx, y - shiftDy)
      const currVal = currGrid[i]
      if (prevVal === null || (prevVal < GROWTH_SIGNAL_FLOOR && currVal < GROWTH_SIGNAL_FLOOR)) {
        out[i] = 1
        continue
      }
      const ratio = currVal / Math.max(prevVal, GROWTH_SIGNAL_FLOOR)
      out[i] = Math.min(GROWTH_RATIO_MAX, Math.max(GROWTH_RATIO_MIN, ratio))
    }
  }
  return out
}

type EchoEvolution = {
  motion: { u: number; v: number }
  growthGrid: Float32Array
  gridSize: number
  dtMinutes: number
}

// Estimates how a RainViewer frame is actually evolving — both its overall
// motion and, per region, whether it's intensifying or weakening — by
// comparing it against the previous frame (both already stitched to the same
// raster/bounds), rather than relying on surface wind observations. This is
// closer to how RainViewer's own app keeps extrapolating past its published
// nowcast window: real storms grow/decay in place at least as much as they
// translate, which a pure position-shift can never represent.
function estimateEchoEvolution(
  prevCanvas: HTMLCanvasElement,
  currCanvas: HTMLCanvasElement,
  bounds: L.LatLngBounds,
  dtMinutes: number,
): EchoEvolution | null {
  if (dtMinutes <= 0) return null
  const prevGrid = toMotionGrid(prevCanvas, MOTION_GRID_SIZE)
  const currGrid = toMotionGrid(currCanvas, MOTION_GRID_SIZE)
  if (!prevGrid || !currGrid) return null
  const shift = estimateGridShift(prevGrid, currGrid, MOTION_GRID_SIZE, MOTION_SEARCH_RADIUS)
  if (!shift) return null
  const scaleX = currCanvas.width / MOTION_GRID_SIZE
  const scaleY = currCanvas.height / MOTION_GRID_SIZE
  const motion = pixelShiftToVelocity(
    shift.dx * scaleX,
    shift.dy * scaleY,
    bounds,
    currCanvas.width,
    currCanvas.height,
    dtMinutes,
  )
  const growthGrid = buildGrowthGrid(prevGrid, currGrid, MOTION_GRID_SIZE, shift.dx, shift.dy)
  return { motion, growthGrid, gridSize: MOTION_GRID_SIZE, dtMinutes }
}

// Renders a future frame from measured echo motion AND per-region growth —
// unlike renderWindDriftFrame (a pure position shift), this walks every
// destination pixel back to its source position and scales that pixel's
// alpha by how much its region was measured to be intensifying or weakening,
// extrapolated to the requested lead time. Needs real pixel access (only
// available for RainViewer's CORS-enabled tiles, not MSS's images).
function renderEchoEvolutionFrame(
  canvas: HTMLCanvasElement,
  source: ImageData,
  w: number,
  h: number,
  bounds: L.LatLngBounds,
  evolution: EchoEvolution,
  offsetMinutes: number,
) {
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  if (offsetMinutes <= 0) {
    ctx.putImageData(source, 0, 0)
    return
  }

  const sw = bounds.getSouthWest()
  const ne = bounds.getNorthEast()
  const degLat = ne.lat - sw.lat
  const degLon = ne.lng - sw.lng
  const centerLat = (sw.lat + ne.lat) / 2
  const pxPerDegLat = h / degLat
  const pxPerDegLon = w / degLon

  const distanceKmU = evolution.motion.u * (offsetMinutes / 60)
  const distanceKmV = evolution.motion.v * (offsetMinutes / 60)
  const dxPx = Math.round((distanceKmU / KM_PER_DEG_LAT / Math.cos((centerLat * Math.PI) / 180)) * pxPerDegLon)
  // Northward (+v) motion moves content toward smaller row indices (up).
  const dyPx = Math.round(-(distanceKmV / KM_PER_DEG_LAT) * pxPerDegLat)

  const growthPower = Math.min(GROWTH_POWER_CAP, offsetMinutes / evolution.dtMinutes)
  const { growthGrid, gridSize } = evolution
  const gridScaleX = w / gridSize
  const gridScaleY = h / gridSize

  const src = source.data
  const out = ctx.createImageData(w, h)
  const dst = out.data

  for (let y = 0; y < h; y++) {
    const srcY = y - dyPx
    if (srcY < 0 || srcY >= h) continue
    const gy = Math.min(gridSize - 1, Math.max(0, Math.floor(srcY / gridScaleY)))
    const rowOff = y * w
    const srcRowOff = srcY * w
    for (let x = 0; x < w; x++) {
      const srcX = x - dxPx
      if (srcX < 0 || srcX >= w) continue
      const gx = Math.min(gridSize - 1, Math.max(0, Math.floor(srcX / gridScaleX)))
      const ratio = growthGrid[gy * gridSize + gx]
      const growth = Math.min(GROWTH_FACTOR_MAX, Math.max(GROWTH_FACTOR_MIN, Math.pow(ratio, growthPower)))

      const si = (srcRowOff + srcX) * 4
      const di = (rowOff + x) * 4
      dst[di] = src[si]
      dst[di + 1] = src[si + 1]
      dst[di + 2] = src[si + 2]
      dst[di + 3] = Math.min(255, src[si + 3] * growth)
    }
  }

  ctx.putImageData(out, 0, 0)
}

// Extrapolates the latest observed MSS radar image forward using real
// per-station wind data. This is a physical estimate (precipitation broadly
// follows low-level wind over short horizons), not an official forecast —
// it's faded and blurred out with lead time, and clearly labeled as such in
// the UI.
function LiquidNowcastLayer({
  baseFrame,
  windField,
  offsetMinutes,
  opacity,
  visible,
}: {
  baseFrame: RadarFrame | null
  windField: WindField | null
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

  // Load the base frame image once per URL (a plain <img>, never read back
  // pixel-by-pixel — only drawImage'd — so this works fine despite MSS's
  // radar images not sending CORS headers for our origin).
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

  // Redraw the sheared composite whenever the lead time, wind field, or base
  // image changes.
  useEffect(() => {
    const canvas = canvasRef.current
    const img = imgRef.current
    if (!canvas || !img || !img.naturalWidth) return
    if (!visible) return
    const drift: DriftSource | null = windField ? { kind: 'stations', stations: windField.stations } : null
    renderWindDriftFrame(canvas, img, img.naturalWidth, img.naturalHeight, MSS_BOUNDS, drift, offsetMinutes)
    canvas.style.filter = `blur(${(offsetMinutes / FUTURE_MINUTES) * 3}px)`
    canvas.style.opacity = String(opacity * nowcastFade(offsetMinutes))
  }, [imgReady, windField, offsetMinutes, opacity, visible])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    if (!visible) canvas.style.opacity = '0'
  }, [visible])

  return null
}

// Extrapolates RainViewer's latest global radar frame forward — RainViewer's
// own published nowcast feed is intermittent (often empty for this region),
// and without this the GLOBAL view would otherwise sit frozen on one frame
// for the whole future range. Unlike LiquidNowcastLayer (MSS), this measures
// real echo motion AND per-region growth/decay between the two latest
// RainViewer frames (see estimateEchoEvolution) instead of relying on surface
// wind observations — RainViewer's tiles, unlike MSS's images, send CORS
// headers that let us read pixels back for that comparison, which is also
// what lets cells intensify/weaken in place as they extrapolate forward
// rather than just sliding as a frozen shape (a plain position-shift can
// never do that — see conversation about RainViewer's own future radar
// growing new cells instead of just sliding the old ones). Falls back to the
// station wind average, with no growth/decay term, when that measurement
// isn't available or isn't confident. RainViewer only serves a slippy tile
// grid, so each frame's raster is stitched from a small grid of tiles around
// SG/JB first (see RAINVIEWER_STITCH_BOUNDS) rather than loaded as one image
// like MSS's composite.
function RainviewerLiquidNowcastLayer({
  host,
  pastFrames,
  windField,
  offsetMinutes,
  opacity,
  visible,
  colorScheme = '4/1_1',
}: {
  host: string | null
  pastFrames: RainviewerFrame[]
  windField: WindField | null
  offsetMinutes: number
  opacity: number
  visible: boolean
  colorScheme?: string
}) {
  const map = useMap()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const stitchRef = useRef<HTMLCanvasElement | null>(null)
  const sourceDataRef = useRef<ImageData | null>(null)
  const evolutionRef = useRef<EchoEvolution | null>(null)
  const loadedKeyRef = useRef<string | null>(null)
  const [stitchReady, setStitchReady] = useState(0)

  const latest = pastFrames.length > 0 ? pastFrames[pastFrames.length - 1] : null
  const previous = pastFrames.length > 1 ? pastFrames[pastFrames.length - 2] : null

  useEffect(() => {
    const canvas = L.DomUtil.create('canvas', 'radar-image') as HTMLCanvasElement
    canvas.style.position = 'absolute'
    canvas.style.pointerEvents = 'none'
    map.getPanes().overlayPane!.appendChild(canvas)
    canvasRef.current = canvas

    const reposition = () => {
      const topLeft = map.latLngToLayerPoint(RAINVIEWER_STITCH_BOUNDS.getNorthWest())
      const bottomRight = map.latLngToLayerPoint(RAINVIEWER_STITCH_BOUNDS.getSouthEast())
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

  // Fetch the small tile grid covering SG/JB and draw it into one offscreen
  // raster, for both the latest frame (what's actually displayed) and the one
  // before it (used only to measure motion, never displayed). RainViewer's
  // tiles send CORS headers, so these are loaded with crossOrigin set,
  // letting the motion search below read them back with getImageData.
  useEffect(() => {
    if (!host || !latest) return
    const cacheKey = `${host}:${latest.path}:${previous?.path ?? ''}:${colorScheme}`
    if (loadedKeyRef.current === cacheKey && stitchRef.current) return
    let cancelled = false

    async function stitchFrame(frame: RainviewerFrame): Promise<HTMLCanvasElement> {
      const cols = RV_MAX_TILE_X - RV_MIN_TILE_X + 1
      const rows = RV_MAX_TILE_Y - RV_MIN_TILE_Y + 1
      const stitch = document.createElement('canvas')
      stitch.width = cols * 256
      stitch.height = rows * 256
      const ctx = stitch.getContext('2d')!
      const loads: Promise<void>[] = []
      for (let ty = RV_MIN_TILE_Y; ty <= RV_MAX_TILE_Y; ty++) {
        for (let tx = RV_MIN_TILE_X; tx <= RV_MAX_TILE_X; tx++) {
          const url = `${host}${frame.path}/256/${RAINVIEWER_MAX_NATIVE_ZOOM}/${tx}/${ty}/${colorScheme}.png`
          loads.push(
            new Promise((resolve) => {
              const img = new Image()
              img.crossOrigin = 'anonymous'
              img.onload = () => {
                ctx.drawImage(img, (tx - RV_MIN_TILE_X) * 256, (ty - RV_MIN_TILE_Y) * 256)
                resolve()
              }
              img.onerror = () => resolve()
              img.src = url
            }),
          )
        }
      }
      await Promise.all(loads)
      return stitch
    }

    ;(async () => {
      const latestStitch = await stitchFrame(latest)
      if (cancelled) return

      let evolution: EchoEvolution | null = null
      if (previous) {
        const previousStitch = await stitchFrame(previous)
        if (cancelled) return
        const dtMinutes = (latest.time - previous.time) / 60
        evolution = estimateEchoEvolution(previousStitch, latestStitch, RAINVIEWER_STITCH_BOUNDS, dtMinutes)
      }

      // Growth/decay extrapolation needs real pixel access to the displayed
      // frame itself (not just the downsampled grids used to measure it).
      let sourceData: ImageData | null = null
      if (evolution) {
        try {
          sourceData = latestStitch.getContext('2d')!.getImageData(0, 0, latestStitch.width, latestStitch.height)
        } catch {
          evolution = null // fail closed to the plain shift-only fallback below
        }
      }

      stitchRef.current = latestStitch
      sourceDataRef.current = sourceData
      evolutionRef.current = evolution
      loadedKeyRef.current = cacheKey
      setStitchReady((r) => r + 1)
    })()

    return () => {
      cancelled = true
    }
  }, [host, latest, previous, colorScheme])

  useEffect(() => {
    const canvas = canvasRef.current
    const stitch = stitchRef.current
    if (!canvas || !stitch) return
    if (!visible) return

    const evolution = evolutionRef.current
    const sourceData = sourceDataRef.current
    if (evolution && sourceData) {
      renderEchoEvolutionFrame(canvas, sourceData, stitch.width, stitch.height, RAINVIEWER_STITCH_BOUNDS, evolution, offsetMinutes)
    } else {
      const drift: DriftSource | null = windField ? uniformDriftFromStationAverage(windField) : null
      renderWindDriftFrame(canvas, stitch, stitch.width, stitch.height, RAINVIEWER_STITCH_BOUNDS, drift, offsetMinutes)
    }
    canvas.style.filter = `blur(${(offsetMinutes / FUTURE_MINUTES) * 3}px)`
    canvas.style.opacity = String(opacity * nowcastFade(offsetMinutes))
  }, [stitchReady, windField, offsetMinutes, opacity, visible])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    if (!visible) canvas.style.opacity = '0'
  }, [visible])

  return null
}

// Real predicted radar tiles straight from RainViewer's own nowcast, when they've
// published any (their free feed is intermittent — often empty). Same crossfade
// pattern as RadarImageLayer, but tile-based since RainViewer serves a slippy grid.
function RainviewerNowcastLayer({
  host,
  frame,
  opacity,
  visible,
  colorScheme = '4/1_1',
}: {
  host: string | null
  frame: RainviewerFrame | null
  opacity: number
  visible: boolean
  // RainViewer's tile path segment for {color}/{smooth_snow}; radar defaults to
  // its palette-4 smoothed scheme, satellite IR tiles want the raw '0/0_0'.
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
      const url = `${host}${frame.path}/256/{z}/{x}/{y}/${colorScheme}.png`
      layer = L.tileLayer(url, {
        opacity: 0,
        zIndex: 18,
        tileSize: 256,
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
    // Same as RadarImageLayer: a layer just added at opacity 0 needs one
    // committed frame before changing it, or the fade-in gets skipped.
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
// animated wind indicators in RainViewer's own app — built from the same
// per-station wind field already fetched for the nowcast drift estimate, so
// each arrow points where the air is actually moving at that spot right now.
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

const PAST_MINUTES = 60
const FUTURE_MINUTES = 120
const STEP_MINUTES = 5
// Fallback guess used only for the brief moment before the first real probe
// (below) resolves — after that, "now" is whatever MSS frame actually loaded.
const LIVE_SAFETY_BUFFER_MINUTES = 5
// Playback speed for the continuous glide, tuned to roughly match the old
// stepped pace (5 min every 700ms) so a full sweep of the timeline still
// takes about 25s.
const PLAYBACK_MIN_PER_SEC = (PAST_MINUTES + FUTURE_MINUTES) / 25

export default function RadarMap() {
  const [nowAnchor, setNowAnchor] = useState(() =>
    floorToSgFiveMin(Date.now() - LIVE_SAFETY_BUFFER_MINUTES * 60 * 1000),
  )
  const [windField, setWindField] = useState<WindField | null>(null)
  const [rainviewer, setRainviewer] = useState<RainviewerData | null>(null)
  const [offsetMinutes, setOffsetMinutes] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [playbackRate, setPlaybackRate] = useState(1)
  // Fixed rather than user-adjustable — one less control cluttering the screen.
  const opacity = 0.92
  const [radarSource, setRadarSource] = useState<RadarSource>('mss')
  const [windVisible, setWindVisible] = useState(true)
  const [legendOpen, setLegendOpen] = useState(false)
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
  // publish-latency guess), so "LIVE" reflects real data availability rather
  // than an assumption that's sometimes too tight (blank frame) or too loose
  // (stale frame). Re-probes on an interval and whenever the tab regains
  // focus, so returning from background doesn't leave a stale frame showing.
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
      try {
        const res = await fetch(RAINVIEWER_API)
        if (!res.ok) return
        const json = await res.json()
        if (!cancelled) {
          setRainviewer({
            host: json.host,
            past: json.radar?.past ?? [],
            nowcast: json.radar?.nowcast ?? [],
          })
        }
      } catch {
        // Silently skip — the wind-drift estimate remains available as a fallback.
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

  const isFuture = offsetMinutes > 0
  // Whole-minute snap of the continuously-gliding offset, used anywhere the
  // raw float would render an ugly fraction (badge text, the LIVE check).
  const roundedOffset = Math.round(offsetMinutes)

  const currentFrame: RadarFrame | null = useMemo(() => {
    if (pastFrames.length === 0) return null
    const targetEpoch = nowAnchor + offsetMinutes * 60 * 1000
    let closest = pastFrames[0]
    let bestDiff = Infinity
    for (const f of pastFrames) {
      const diff = Math.abs(f.epoch - targetEpoch)
      if (diff < bestDiff) {
        bestDiff = diff
        closest = f
      }
    }
    return closest
  }, [pastFrames, nowAnchor, offsetMinutes])

  const liveFrame = pastFrames.length > 0 ? pastFrames[pastFrames.length - 1] : null

  const displayTargetEpoch = nowAnchor + offsetMinutes * 60 * 1000

  const matchingRainviewerFrame: RainviewerFrame | null = useMemo(() => {
    if (!isFuture || !rainviewer || rainviewer.nowcast.length === 0) return null
    const best = closestRainviewerFrame(rainviewer.nowcast, displayTargetEpoch)
    if (!best) return null
    return Math.abs(best.time * 1000 - displayTargetEpoch) <= RAINVIEWER_MATCH_TOLERANCE_MIN * 60 * 1000
      ? best
      : null
  }, [isFuture, rainviewer, displayTargetEpoch])

  const usingRealNowcast = isFuture && radarSource === 'rainviewer' && matchingRainviewerFrame !== null

  // RainViewer's own past-radar mosaic (same source their web/app clients
  // render), used instead of MSS's composite when radarSource is 'rainviewer'.
  const matchingRainviewerPastFrame: RainviewerFrame | null = useMemo(() => {
    if (isFuture || !rainviewer || rainviewer.past.length === 0) return null
    return closestRainviewerFrame(rainviewer.past, displayTargetEpoch)
  }, [isFuture, rainviewer, displayTargetEpoch])

  // When GLOBAL is selected but RainViewer hasn't published a real nowcast
  // frame for this lead time, echo-drift their latest live frame (via
  // RainviewerLiquidNowcastLayer below) instead of ever falling back to the
  // MSS-based extrapolation — keeps the two radar sources from ever showing
  // at once, and keeps the future view moving instead of sitting frozen.

  const displayEpoch = displayTargetEpoch

  // Whether the currently visible radar imagery is actually rendered from
  // RainViewer's own tiles (their palette), as opposed to MSS's composite or
  // our wind-drifted extrapolation of it (MSS's palette) — this now tracks the
  // selected source directly rather than what happened to be available.
  const usingRainviewerPalette = radarSource === 'rainviewer'

  // Glides offsetMinutes continuously via rAF rather than jumping in fixed
  // 5-min steps, so playback reads as one smooth sweep across the timeline —
  // the thumb and displayed time drift steadily instead of snapping frame to
  // frame. The underlying radar frame still only actually swaps (and
  // crossfades) when the continuous offset crosses into the next 5-min
  // bucket, via the existing nearest-frame match in `currentFrame`.
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
          <TileLayer
            // Positron ("light_all") is CARTO's light basemap: subtle blue
            // water and green parks with plain neutral-gray roads (unlike
            // Voyager, which paints highways orange/yellow) — closest match
            // to a clean Apple/Google Maps look once inverted to dark. The
            // invert+hue-rotate(180) combo in .basemap-tile below flips it into
            // a dark theme while keeping each feature's original hue intact.
            url="https://{s}.basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}{r}.png"
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
            subdomains="abcd"
            className="basemap-tile"
          />
          <RadarImageLayer
            frame={currentFrame}
            opacity={opacity}
            visible={!isFuture && radarSource === 'mss'}
          />
          <RainviewerNowcastLayer
            host={rainviewer?.host ?? null}
            frame={matchingRainviewerPastFrame}
            opacity={opacity}
            visible={!isFuture && radarSource === 'rainviewer'}
          />
          <RainviewerNowcastLayer
            host={rainviewer?.host ?? null}
            frame={matchingRainviewerFrame}
            opacity={opacity}
            visible={usingRealNowcast}
          />
          <RainviewerLiquidNowcastLayer
            host={rainviewer?.host ?? null}
            pastFrames={rainviewer?.past ?? []}
            windField={windField}
            offsetMinutes={offsetMinutes}
            opacity={opacity}
            visible={isFuture && radarSource === 'rainviewer' && !usingRealNowcast}
          />
          <LiquidNowcastLayer
            baseFrame={liveFrame}
            windField={windField}
            offsetMinutes={offsetMinutes}
            opacity={opacity}
            visible={isFuture && radarSource === 'mss'}
          />
          <WindArrowLayer stations={windField?.stations ?? []} visible={windVisible} />
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
          </div>
        </MapContainer>

        {/* Required credit for the free CARTO/OpenStreetMap basemap tier — kept
            small and out of the way of the floating controls above it, in the
            thin strip beneath them rather than Leaflet's default clunky box. */}
        <div className="map-attribution">
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">
            OpenStreetMap
          </a>
          {' · '}
          <a href="https://carto.com/attributions" target="_blank" rel="noopener noreferrer">
            CARTO
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
                background: `linear-gradient(to top, ${(usingRainviewerPalette ? RAINVIEWER_INTENSITY_COLORS : INTENSITY_COLORS).join(',')})`,
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
                step={STEP_MINUTES}
                value={offsetMinutes}
                onChange={(e) => {
                  const next = Number(e.target.value)
                  // Fires once per 5-min tick crossed (native range stepping
                  // only emits change at step boundaries), so this taps a
                  // vibration once per dot the thumb passes while dragging.
                  if (next !== offsetMinutes) triggerTickHaptic()
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
