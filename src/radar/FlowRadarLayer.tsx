import { useEffect, useRef, useState } from 'react'
import { useMap } from 'react-leaflet'
import L from 'leaflet'
import { buildLut, decodeLevels, type Palette } from './palette'
import {
  downsampleLevels,
  estimateFlowField,
  estimateGlobalShift,
  estimateTrend,
  scaleFlow,
  uniformFlow,
  type AnalysisConfig,
  type Field,
  type FlowField,
} from './motion'
import { FlowRenderer } from './flowRenderer'

const KM_PER_DEG = 111.32

export type FlowKeyframe = { key: string; time: number }

export type SteeringWind = { u: number; v: number } // km/h east / north

export type FlowSourceConfig = AnalysisConfig & {
  // Gap between the two scans the forecast motion/trend is measured across.
  // Wider than one scan interval so slow tropical cells move measurably.
  baselineMin: number
  // Search radius (analysis cells) around the prior for the baseline motion.
  searchRadius: number
  // Search radius around the scaled baseline motion for each scan pair.
  pairRadius: number
  // Fraction of the image that must be raining before radar-tracked motion
  // is trusted over the steering wind. Scattered specks don't track reliably.
  minCoverage: number
}

export type MotionSource = 'radar' | 'steering' | 'none'

export type FlowStatus = {
  ready: boolean
  latestScan: number | null
  motionSource: MotionSource
  speedKmh: number
  towardBearingDeg: number
}

type Decoded = {
  key: string
  time: number
  w: number
  h: number
  grid: Field
}

type Nowcast = {
  // What it was measured from, so it's only re-measured when that changes.
  inputs: string
  // Domain-wide motion in analysis cells over dtMinutes; seeds pair searches.
  shift: { dx: number; dy: number; dt: number }
  flow: FlowField
  flowKey: string
  trendKey: string | null
  dtMinutes: number
  source: MotionSource
  speedKmh: number
  towardBearingDeg: number
}

// Lead-time smoothing: forecast skill for small features decays fastest, so
// the extrapolated field is progressively smoothed. km of radius per minute
// of lead time (~6 km at +2h).
const BLUR_KM_PER_MIN = 0.05
// Trend saturation, in baseline intervals: the measured growth/decay is
// applied at most ~this many intervals' worth, since trends don't persist.
const TREND_TAU = 1
// Largest disagreement (km/h) between the latest and the previous baseline's
// motion for the radar-tracked vector to be trusted over the steering wind.
const MAX_MOTION_DISAGREEMENT_KMH = 12
// Hard ceiling on the backing canvas so very high zoom on a big screen can't
// allocate something enormous.
const MAX_BACKING_PX = 2560
const MAX_BACKING_AREA = 5_000_000

// A canvas pinned to a geographic domain, but only ever covering the part of
// it that's in (or near) view — so the backing store can match screen
// resolution and edges stay crisp at street-level zoom, without allocating a
// 10,000px canvas for the whole domain. Handles Leaflet's zoom animation the
// same way L.ImageOverlay does.
class CanvasOverlay extends L.Layer {
  canvas: HTMLCanvasElement
  domain: L.LatLngBounds
  view: [number, number, number, number] = [0, 0, 1, 1]
  onRedraw: () => void
  private viewRect: L.Bounds | null = null
  private host: L.Map | null = null

  constructor(domain: L.LatLngBounds, onRedraw: () => void) {
    super()
    this.domain = domain
    this.onRedraw = onRedraw
    this.canvas = L.DomUtil.create('canvas', 'radar-flow-canvas')
  }

  onAdd(map: L.Map) {
    this.host = map
    const animated = map.options.zoomAnimation && L.Browser.any3d
    this.canvas.classList.add(animated ? 'leaflet-zoom-animated' : 'leaflet-zoom-hide')
    this.getPane()!.appendChild(this.canvas)
    this.reset()
    return this
  }

  onRemove() {
    this.canvas.remove()
    this.host = null
    return this
  }

  getEvents() {
    return {
      zoom: this.reset,
      viewreset: this.reset,
      moveend: this.reset,
      resize: this.reset,
      zoomanim: this.animateZoom,
    } as unknown as { [name: string]: L.LeafletEventHandlerFn }
  }

  private animateZoom = (e: L.ZoomAnimEvent) => {
    if (!this.host || !this.viewRect) return
    // Leaflet's own overlays use this (private) projection helper for the
    // zoom animation; there's no public equivalent.
    const map = this.host as unknown as L.Map & {
      _latLngToNewLayerPoint(ll: L.LatLng, z: number, c: L.LatLng): L.Point
    }
    const nw = map.layerPointToLatLng(this.viewRect.min!)
    const scale = map.getZoomScale(e.zoom)
    const offset = map._latLngToNewLayerPoint(nw, e.zoom, e.center)
    L.DomUtil.setTransform(this.canvas, offset, scale)
  }

  reset = () => {
    const map = this.host
    if (!map) return
    const domTL = map.latLngToLayerPoint(this.domain.getNorthWest())
    const domBR = map.latLngToLayerPoint(this.domain.getSouthEast())
    const size = map.getSize()
    const pad = size.multiplyBy(0.25)
    const viewTL = map.containerPointToLayerPoint(L.point(-pad.x, -pad.y))
    const viewBR = map.containerPointToLayerPoint(size.add(pad))
    const tl = L.point(Math.max(domTL.x, viewTL.x), Math.max(domTL.y, viewTL.y)).round()
    const br = L.point(Math.min(domBR.x, viewBR.x), Math.min(domBR.y, viewBR.y)).round()
    if (br.x - tl.x < 1 || br.y - tl.y < 1) {
      this.viewRect = null
      this.canvas.style.display = 'none'
      return
    }
    this.canvas.style.display = ''
    this.viewRect = L.bounds(tl, br)
    const cssW = br.x - tl.x
    const cssH = br.y - tl.y
    L.DomUtil.setPosition(this.canvas, tl)
    this.canvas.style.width = `${cssW}px`
    this.canvas.style.height = `${cssH}px`

    let scale = Math.min(window.devicePixelRatio || 1, 2)
    scale = Math.min(scale, MAX_BACKING_PX / Math.max(cssW, cssH))
    scale = Math.min(scale, Math.sqrt(MAX_BACKING_AREA / (cssW * cssH)))
    const bw = Math.max(1, Math.round(cssW * scale))
    const bh = Math.max(1, Math.round(cssH * scale))
    if (this.canvas.width !== bw) this.canvas.width = bw
    if (this.canvas.height !== bh) this.canvas.height = bh

    const dw = domBR.x - domTL.x
    const dh = domBR.y - domTL.y
    this.view = [(tl.x - domTL.x) / dw, (tl.y - domTL.y) / dh, (br.x - domTL.x) / dw, (br.y - domTL.y) / dh]
    this.onRedraw()
  }
}

// Whether what's decoded is recent enough to draw: the newest decoded scan
// must be close to the newest one on the timeline. Otherwise an hour-old
// scan that happened to finish loading first would be shown as "now", but a
// just-published scan still downloading doesn't blank the layer either.
const CURRENT_TOLERANCE_MS = 15 * 60_000
function isCurrent(decoded: Decoded[], frames: FlowKeyframe[]) {
  if (decoded.length === 0 || frames.length === 0) return false
  return decoded[decoded.length - 1].time >= frames[frames.length - 1].time - CURRENT_TOLERANCE_MS
}

// The scan nearest `target` that is strictly older than `before`.
function closestTo(list: Decoded[], target: number, before: number): Decoded | null {
  let best: Decoded | null = null
  for (const d of list) {
    if (d.time >= before) continue
    if (!best || Math.abs(d.time - target) < Math.abs(best.time - target)) best = d
  }
  return best
}

function domainKm(bounds: L.LatLngBounds) {
  const sw = bounds.getSouthWest()
  const ne = bounds.getNorthEast()
  const midLat = ((sw.lat + ne.lat) / 2) * (Math.PI / 180)
  return { w: (ne.lng - sw.lng) * KM_PER_DEG * Math.cos(midLat), h: (ne.lat - sw.lat) * KM_PER_DEG }
}

// Continuous, motion-compensated radar layer for one source (see
// flowRenderer.ts for what it draws). Frames are decoded to intensity once;
// motion between every consecutive scan pair, plus the forecast motion and
// trend, are measured in the background and reused while scrubbing.
export function FlowRadarLayer({
  enabled,
  frames,
  loadFrame,
  bounds,
  palette,
  config,
  targetTime,
  steering,
  opacity,
  visible,
  onStatus,
}: {
  enabled: boolean
  frames: FlowKeyframe[]
  // Resolves to an image/canvas whose pixels can be read (same-origin or
  // CORS-enabled), or null if the frame couldn't be fetched.
  loadFrame: (key: string) => Promise<HTMLCanvasElement | HTMLImageElement | null>
  bounds: L.LatLngBounds
  palette: Palette
  config: FlowSourceConfig
  targetTime: number
  steering: SteeringWind | null
  opacity: number
  visible: boolean
  onStatus: (s: FlowStatus) => void
}) {
  const map = useMap()
  const overlayRef = useRef<CanvasOverlay | null>(null)
  const rendererRef = useRef<FlowRenderer | null>(null)
  const decodedRef = useRef(new Map<string, Decoded>())
  const inflightRef = useRef(new Set<string>())
  const pairFlowsRef = useRef(new Map<string, string>()) // pair key -> flow texture key
  const nowcastRef = useRef<Nowcast | null>(null)
  const [loadVersion, setLoadVersion] = useState(0)
  const [analysisVersion, setAnalysisVersion] = useState(0)
  const [unsupported, setUnsupported] = useState(false)
  const drawRef = useRef<() => void>(() => {})
  const rafRef = useRef<number | null>(null)
  const onStatusRef = useRef(onStatus)
  onStatusRef.current = onStatus

  const scheduleDraw = () => {
    if (rafRef.current !== null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      drawRef.current()
    })
  }

  // Overlay + GL context live for the component's lifetime.
  useEffect(() => {
    const overlay = new CanvasOverlay(bounds, () => drawRef.current())
    overlayRef.current = overlay
    const renderer = FlowRenderer.create(overlay.canvas)
    if (!renderer) {
      setUnsupported(true)
      return
    }
    renderer.setLut(buildLut(palette))
    rendererRef.current = renderer
    overlay.addTo(map)
    const decoded = decodedRef.current
    const pairFlows = pairFlowsRef.current
    const inflight = inflightRef.current
    return () => {
      // Loads still in flight belong to this renderer and will be discarded
      // on arrival, so forget them or a remount would never re-request them.
      inflight.clear()
      overlay.remove()
      renderer.dispose()
      rendererRef.current = null
      overlayRef.current = null
      decoded.clear()
      pairFlows.clear()
      nowcastRef.current = null
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [map, bounds, palette])

  // Fetch and decode any keyframes we don't have yet; drop ones that have
  // fallen off the timeline.
  useEffect(() => {
    if (!enabled) return
    const renderer = rendererRef.current
    if (!renderer) return
    const decoded = decodedRef.current
    const wanted = new Set(frames.map((f) => f.key))
    let dropped = false
    for (const key of [...decoded.keys()]) {
      if (!wanted.has(key)) {
        decoded.delete(key)
        renderer.delete(key)
        dropped = true
      }
    }
    if (dropped) setLoadVersion((v) => v + 1)

    // Failed scans aren't remembered, so they're retried whenever the
    // timeline moves (a network blip shouldn't leave a permanent gap).
    for (const f of frames) {
      if (decoded.has(f.key) || inflightRef.current.has(f.key)) continue
      inflightRef.current.add(f.key)
      loadFrame(f.key).then((img) => {
        inflightRef.current.delete(f.key)
        if (rendererRef.current !== renderer) return
        if (!img) return
        const w = img instanceof HTMLImageElement ? img.naturalWidth : img.width
        const h = img instanceof HTMLImageElement ? img.naturalHeight : img.height
        const c = document.createElement('canvas')
        c.width = w
        c.height = h
        const ctx = c.getContext('2d', { willReadFrequently: true })!
        ctx.drawImage(img, 0, 0)
        let rgba: Uint8ClampedArray
        try {
          rgba = ctx.getImageData(0, 0, w, h).data
        } catch {
          return
        }
        const levels = decodeLevels(rgba, palette)
        renderer.uploadLevels(f.key, levels, w, h)
        decoded.set(f.key, { key: f.key, time: f.time, w, h, grid: downsampleLevels(levels, w, h, config.factor) })
        setLoadVersion((v) => v + 1)
      })
    }
  }, [enabled, frames, loadFrame, palette, config.factor])

  // Measure motion: first the forecast motion across the baseline (which
  // also seeds every pair search), then each consecutive scan pair. Runs in
  // small chunks so it never blocks scrolling/scrubbing for long.
  useEffect(() => {
    const renderer = rendererRef.current
    if (!renderer) return
    const list = [...decodedRef.current.values()].sort((a, b) => a.time - b.time)
    if (list.length === 0) return
    const latest = list[list.length - 1]
    const km = domainKm(bounds)
    const cellKmX = km.w / latest.grid.w
    const cellKmY = km.h / latest.grid.h

    let cancelled = false
    const jobs: (() => void)[] = []

    const nowcastKey = `nowcast:${latest.key}`
    const prev = closestTo(list, latest.time - config.baselineMin * 60_000, latest.time)
    const nowcastInputs = `${prev?.key}|${latest.key}|${steering ? `${steering.u.toFixed(1)},${steering.v.toFixed(1)}` : ''}`
    const existing = nowcastRef.current
    let baseShift: { dx: number; dy: number; dt: number } | null =
      existing && existing.inputs === nowcastInputs ? existing.shift : null
    if (!baseShift) jobs.push(() => {
      const dt = prev ? (latest.time - prev.time) / 60_000 : config.baselineMin
      const prior = steering
        ? { dx: (steering.u * dt) / 60 / cellKmX, dy: (-steering.v * dt) / 60 / cellKmY }
        : { dx: 0, dy: 0 }
      let flow: FlowField | null = null
      let trend: Field | null = null
      let source: MotionSource = 'none'
      let gdx = 0
      let gdy = 0
      if (prev) {
        const shift = estimateGlobalShift(prev.grid, latest.grid, prior.dx, prior.dy, config.searchRadius)
        // Independent check one baseline earlier: real storm motion holds
        // steady over a quarter hour, noise doesn't. Backtests showed
        // scattered showers producing confident-looking but random vectors
        // that this rejects.
        let consistent = true
        const prev2 = closestTo(list, prev.time - dt * 60_000, prev.time)
        if (shift?.confident && prev2) {
          const dt2 = (prev.time - prev2.time) / 60_000
          const k = dt2 / dt
          const earlier = estimateGlobalShift(prev2.grid, prev.grid, prior.dx * k, prior.dy * k, config.searchRadius)
          if (earlier?.confident) {
            const du = ((shift.dx / dt - earlier.dx / dt2) * cellKmX * 60)
            const dv = ((shift.dy / dt - earlier.dy / dt2) * cellKmY * 60)
            consistent = Math.hypot(du, dv) <= MAX_MOTION_DISAGREEMENT_KMH
          } else if (earlier) {
            consistent = false
          }
        }
        let raining = 0
        for (const x of latest.grid.data) if (x >= 0.5) raining++
        const enoughRain = raining / latest.grid.data.length >= config.minCoverage
        if (shift?.confident && consistent && (enoughRain || !steering)) {
          gdx = shift.dx
          gdy = shift.dy
          source = 'radar'
        } else if (steering) {
          gdx = prior.dx
          gdy = prior.dy
          source = 'steering'
        }
        flow =
          source === 'radar'
            ? estimateFlowField(prev.grid, latest.grid, gdx, gdy, { ...config, localRadius: config.localRadius + 2 })
            : uniformFlow(gdx, gdy)
        trend = estimateTrend(prev.grid, latest.grid, flow, 6)
      } else if (steering) {
        gdx = prior.dx
        gdy = prior.dy
        source = 'steering'
        flow = uniformFlow(gdx, gdy)
      }
      if (!flow) flow = uniformFlow(0, 0)
      renderer.uploadFlow(nowcastKey, flow)
      const trendKey = trend ? `${nowcastKey}:trend` : null
      if (trend && trendKey) renderer.uploadTrend(trendKey, trend)
      const u = (gdx * cellKmX) / (dt / 60)
      const v = (-gdy * cellKmY) / (dt / 60)
      baseShift = { dx: gdx, dy: gdy, dt }
      nowcastRef.current = {
        inputs: nowcastInputs,
        shift: baseShift,
        flow,
        flowKey: nowcastKey,
        trendKey,
        dtMinutes: dt,
        source,
        speedKmh: Math.hypot(u, v),
        towardBearingDeg: ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360,
      }
      scheduleDraw()
    })

    for (let i = 0; i + 1 < list.length; i++) {
      const a = list[i]
      const b = list[i + 1]
      const pairKey = `pair:${a.key}|${b.key}`
      if (renderer.has(pairKey)) continue
      jobs.push(() => {
        const dt = (b.time - a.time) / 60_000
        const k = baseShift ? dt / baseShift.dt : 0
        const cx = baseShift ? baseShift.dx * k : 0
        const cy = baseShift ? baseShift.dy * k : 0
        const shift = estimateGlobalShift(a.grid, b.grid, cx, cy, config.pairRadius)
        const gdx = shift?.confident ? shift.dx : cx
        const gdy = shift?.confident ? shift.dy : cy
        const flow = shift ? estimateFlowField(a.grid, b.grid, gdx, gdy, config) : uniformFlow(gdx, gdy)
        renderer.uploadFlow(pairKey, flow)
        pairFlowsRef.current.set(`${a.key}|${b.key}`, pairKey)
        scheduleDraw()
      })
    }

    // Drop pair flows that no longer join two consecutive scans (a scan fell
    // off the timeline, or a late-arriving scan split a pair in two).
    const livePairs = new Set(list.slice(1).map((b, i) => `pair:${list[i].key}|${b.key}`))
    for (const texKey of renderer.keys()) {
      if (texKey.startsWith('pair:')) {
        if (!livePairs.has(texKey)) {
          renderer.delete(texKey)
          pairFlowsRef.current.delete(texKey.slice(5))
        }
      } else if (
        texKey.startsWith('nowcast:') &&
        (!texKey.startsWith(nowcastKey) || (!baseShift && texKey.includes(':scaled:')))
      ) {
        // Stale forecast motion, or scaled copies of a motion about to be
        // re-measured.
        renderer.delete(texKey)
      }
    }

    let timer = 0
    const run = () => {
      if (cancelled) return
      const job = jobs.shift()
      if (!job) {
        setAnalysisVersion((v) => v + 1)
        return
      }
      job()
      timer = window.setTimeout(run, 0)
    }
    timer = window.setTimeout(run, 0)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadVersion, steering, bounds, config])

  // Draw whatever instant is requested.
  drawRef.current = () => {
    const renderer = rendererRef.current
    const overlay = overlayRef.current
    if (!renderer || !overlay) return
    if (renderer.lost) return
    const list = [...decodedRef.current.values()].sort((a, b) => a.time - b.time)
    const shown = visible && isCurrent(list, frames)
    // Hidden outright (not just cleared) so the inactive source's canvas
    // costs nothing to composite.
    overlay.canvas.style.visibility = shown ? '' : 'hidden'
    if (!shown) {
      renderer.clear()
      return
    }
    const latest = list[list.length - 1]
    const gridW = latest.grid.w
    const gridH = latest.grid.h

    if (targetTime <= list[0].time) {
      renderer.draw({ mode: 'interpolate', a: list[0].key, flow: null, t: 0, gridW, gridH, opacity, view: overlay.view })
      return
    }
    if (targetTime < latest.time) {
      let i = 0
      while (i + 1 < list.length && list[i + 1].time <= targetTime) i++
      const a = list[i]
      const b = list[i + 1]
      const t = (targetTime - a.time) / (b.time - a.time)
      let flow = pairFlowsRef.current.get(`${a.key}|${b.key}`) ?? null
      // Until this pair's own motion is measured, borrow the forecast motion
      // (scaled to this pair's interval) rather than plain crossfading.
      const nowcast = nowcastRef.current
      if (!flow && nowcast) {
        const pairMin = (b.time - a.time) / 60_000
        const scaledKey = `${nowcast.flowKey}:scaled:${pairMin}`
        if (!renderer.has(scaledKey)) renderer.uploadFlow(scaledKey, scaleFlow(nowcast.flow, pairMin / nowcast.dtMinutes))
        flow = scaledKey
      }
      renderer.draw({ mode: 'interpolate', a: a.key, b: b.key, flow, t, gridW, gridH, opacity, view: overlay.view })
      return
    }

    const nowcast = nowcastRef.current
    const leadMin = (targetTime - latest.time) / 60_000
    const steps = nowcast ? leadMin / nowcast.dtMinutes : 0
    const km = domainKm(bounds)
    const blurKm = leadMin * BLUR_KM_PER_MIN
    renderer.draw({
      mode: 'extrapolate',
      a: latest.key,
      flow: nowcast?.flowKey ?? null,
      trend: nowcast?.trendKey ?? null,
      t: steps,
      trendGain: TREND_TAU * (1 - Math.exp(-steps / TREND_TAU)),
      gridW,
      gridH,
      blurUv: [blurKm / km.w, blurKm / km.h],
      // Fades gently with lead time so the forecast reads as less certain
      // than observed scans without washing out.
      opacity: opacity * (1 - 0.25 * Math.min(1, leadMin / 120)),
      view: overlay.view,
    })
  }

  useEffect(() => {
    scheduleDraw()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetTime, opacity, visible, analysisVersion, loadVersion])

  // Report readiness/motion to the parent (for fallbacks and the UI note).
  useEffect(() => {
    const list = [...decodedRef.current.values()].sort((a, b) => a.time - b.time)
    const latest = list.length > 0 ? list[list.length - 1] : null
    const nowcast = nowcastRef.current
    onStatusRef.current({
      ready: !unsupported && isCurrent(list, frames),
      latestScan: latest?.time ?? null,
      motionSource: nowcast?.source ?? 'none',
      speedKmh: nowcast?.speedKmh ?? 0,
      towardBearingDeg: nowcast?.towardBearingDeg ?? 0,
    })
  }, [loadVersion, analysisVersion, unsupported, frames])

  return null
}
