// Echo-motion analysis: measures how rain is actually moving (and
// intensifying or weakening) between two radar scans, on intensity levels
// decoded from the images (see palette.ts). This is the same family of
// technique operational nowcasting systems use (block-matching optical flow +
// Lagrangian extrapolation), kept dependency-free and small enough to run on a
// phone.

// A coarse intensity grid the analysis runs on. Values are palette levels.
export type Field = { data: Float32Array; w: number; h: number }

// Per-cell motion, in analysis-grid cells per frame interval. `u` is
// rightward (east), `v` is downward (south, increasing row index) so it
// composes directly with image coordinates.
export type FlowField = { u: Float32Array; v: Float32Array; w: number; h: number }

export type AnalysisConfig = {
  // Source pixels per analysis cell along each axis.
  factor: number
  // Analysis cells per flow-field cell.
  flowCell: number
  // Half-width of the block each flow cell matches on, in analysis cells.
  blockHalf: number
  // How far each flow cell may deviate from the global vector.
  localRadius: number
}

// Below this mean level a block has too little rain to match on and simply
// inherits the global vector.
const SIGNAL_FLOOR = 0.6
// The best shift must beat "no motion" by this fraction of the zero-shift
// error before it's trusted.
const CONFIDENCE_MARGIN = 0.03
// Overlap needed between the shifted grids for a shift to be scored at all.
const MIN_OVERLAP = 0.35
const FLOW_SMOOTH_PASSES = 2

// Box-averages a full-resolution level image down to an analysis grid.
export function downsampleLevels(levels: Uint8Array, w: number, h: number, factor: number): Field {
  const gw = Math.max(1, Math.round(w / factor))
  const gh = Math.max(1, Math.round(h / factor))
  const data = new Float32Array(gw * gh)
  const counts = new Float32Array(gw * gh)
  for (let y = 0; y < h; y++) {
    const gy = Math.min(gh - 1, Math.floor((y * gh) / h))
    for (let x = 0; x < w; x++) {
      const gx = Math.min(gw - 1, Math.floor((x * gw) / w))
      data[gy * gw + gx] += levels[y * w + x]
      counts[gy * gw + gx]++
    }
  }
  for (let i = 0; i < data.length; i++) data[i] /= counts[i] || 1
  return { data, w: gw, h: gh }
}

function totalSignal(f: Field) {
  let s = 0
  for (let i = 0; i < f.data.length; i++) s += f.data[i]
  return s
}

function parabolicOffset(eMinus: number, e0: number, ePlus: number) {
  const denom = eMinus - 2 * e0 + ePlus
  if (!Number.isFinite(eMinus) || !Number.isFinite(ePlus) || denom <= 0) return 0
  return Math.max(-0.5, Math.min(0.5, (0.5 * (eMinus - ePlus)) / denom))
}

// Finds the translation that best aligns `prev` onto `curr` by minimising
// mean squared difference, searching a window of ±radius cells around a prior
// guess (e.g. the upper-level steering wind). Returns null only when neither
// frame has any rain to measure.
export function estimateGlobalShift(
  prev: Field,
  curr: Field,
  centerDx: number,
  centerDy: number,
  radius: number,
): { dx: number; dy: number; confident: boolean; margin: number } | null {
  const { w, h } = curr
  if (totalSignal(prev) < w * h * 0.002 || totalSignal(curr) < w * h * 0.002) return null
  const cx = Math.round(centerDx)
  const cy = Math.round(centerDy)
  const span = radius * 2 + 1
  const err = new Float32Array(span * span).fill(Infinity)
  let bestErr = Infinity
  let bestI = radius
  let bestJ = radius
  const minCount = w * h * MIN_OVERLAP

  for (let j = 0; j < span; j++) {
    const dy = cy + j - radius
    for (let i = 0; i < span; i++) {
      const dx = cx + i - radius
      let sum = 0
      let count = 0
      const y0 = Math.max(0, dy)
      const y1 = Math.min(h, h + dy)
      const x0 = Math.max(0, dx)
      const x1 = Math.min(w, w + dx)
      for (let y = y0; y < y1; y++) {
        const row = y * w
        const prow = (y - dy) * w - dx
        for (let x = x0; x < x1; x++) {
          const d = curr.data[row + x] - prev.data[prow + x]
          sum += d * d
        }
        count += x1 - x0
      }
      if (count < minCount) continue
      const e = sum / count
      err[j * span + i] = e
      if (e < bestErr) {
        bestErr = e
        bestI = i
        bestJ = j
      }
    }
  }
  if (!Number.isFinite(bestErr)) return null

  // Error of "nothing moved", measured directly even when it's outside the
  // search window around the prior.
  let zeroSum = 0
  for (let k = 0; k < w * h; k++) {
    const d = curr.data[k] - prev.data[k]
    zeroSum += d * d
  }
  const zeroErr = zeroSum / (w * h)
  const margin = zeroErr > 0 ? (zeroErr - bestErr) / zeroErr : 0
  // A best match pinned to the edge of the search window means the real
  // optimum wasn't found — on scattered specks this is exactly what noise
  // looks like — so it isn't trusted however good its margin.
  const onEdge = bestI === 0 || bestJ === 0 || bestI === span - 1 || bestJ === span - 1
  const confident = !onEdge && margin >= CONFIDENCE_MARGIN

  const subI = bestI > 0 && bestI < span - 1 ? parabolicOffset(err[bestJ * span + bestI - 1], bestErr, err[bestJ * span + bestI + 1]) : 0
  const subJ = bestJ > 0 && bestJ < span - 1 ? parabolicOffset(err[(bestJ - 1) * span + bestI], bestErr, err[(bestJ + 1) * span + bestI]) : 0
  return { dx: cx + bestI - radius + subI, dy: cy + bestJ - radius + subJ, confident, margin }
}

// Recovers a per-cell motion field by matching a block around each flow cell
// between the two frames, searching only a small neighbourhood around the
// global vector. Cells without enough rain inherit the global vector, so
// empty sky never invents its own motion. Real rain fields shear and rotate;
// one rigid vector for the whole map is what makes a nowcast look fake.
export function estimateFlowField(
  prev: Field,
  curr: Field,
  globalDx: number,
  globalDy: number,
  cfg: AnalysisConfig,
): FlowField {
  const { w, h } = curr
  const fw = Math.max(1, Math.round(w / cfg.flowCell))
  const fh = Math.max(1, Math.round(h / cfg.flowCell))
  const u = new Float32Array(fw * fh)
  const v = new Float32Array(fw * fh)
  const baseDx = Math.round(globalDx)
  const baseDy = Math.round(globalDy)
  const r = cfg.localRadius
  const span = r * 2 + 1
  const errs = new Float32Array(span * span)

  for (let fy = 0; fy < fh; fy++) {
    for (let fx = 0; fx < fw; fx++) {
      const idx = fy * fw + fx
      u[idx] = globalDx
      v[idx] = globalDy
      const cx = Math.round(((fx + 0.5) * w) / fw)
      const cy = Math.round(((fy + 0.5) * h) / fh)
      const x0 = Math.max(0, cx - cfg.blockHalf)
      const x1 = Math.min(w - 1, cx + cfg.blockHalf)
      const y0 = Math.max(0, cy - cfg.blockHalf)
      const y1 = Math.min(h - 1, cy + cfg.blockHalf)
      const blockCells = (x1 - x0 + 1) * (y1 - y0 + 1)

      let signal = 0
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) signal += curr.data[y * w + x]
      if (signal / blockCells < SIGNAL_FLOOR) continue

      errs.fill(Infinity)
      let bestErr = Infinity
      let bestI = r
      let bestJ = r
      for (let j = 0; j < span; j++) {
        const dy = baseDy + j - r
        for (let i = 0; i < span; i++) {
          const dx = baseDx + i - r
          let sum = 0
          let count = 0
          for (let y = y0; y <= y1; y++) {
            const py = y - dy
            if (py < 0 || py >= h) continue
            for (let x = x0; x <= x1; x++) {
              const px = x - dx
              if (px < 0 || px >= w) continue
              const d = curr.data[y * w + x] - prev.data[py * w + px]
              sum += d * d
              count++
            }
          }
          if (count < blockCells * 0.5) continue
          const e = sum / count
          errs[j * span + i] = e
          if (e < bestErr) {
            bestErr = e
            bestI = i
            bestJ = j
          }
        }
      }
      if (!Number.isFinite(bestErr)) continue
      const subI = bestI > 0 && bestI < span - 1 ? parabolicOffset(errs[bestJ * span + bestI - 1], bestErr, errs[bestJ * span + bestI + 1]) : 0
      const subJ = bestJ > 0 && bestJ < span - 1 ? parabolicOffset(errs[(bestJ - 1) * span + bestI], bestErr, errs[(bestJ + 1) * span + bestI]) : 0
      u[idx] = baseDx + bestI - r + subI
      v[idx] = baseDy + bestJ - r + subJ
    }
  }

  smoothField(u, fw, fh, FLOW_SMOOTH_PASSES)
  smoothField(v, fw, fh, FLOW_SMOOTH_PASSES)
  return { u, v, w: fw, h: fh }
}

// A flow field with the same vector everywhere (used when the only motion
// estimate is a single prior, e.g. the steering wind).
export function uniformFlow(dx: number, dy: number): FlowField {
  return { u: new Float32Array([dx]), v: new Float32Array([dy]), w: 1, h: 1 }
}

export function scaleFlow(flow: FlowField, k: number): FlowField {
  return { u: flow.u.map((x) => x * k), v: flow.v.map((x) => x * k), w: flow.w, h: flow.h }
}

// 3x3 box smoothing in place. Neighbouring cells describe the same air mass
// and should largely agree; this removes isolated bad block matches that would
// otherwise tear the advected image.
function smoothField(a: Float32Array, w: number, h: number, passes: number) {
  const tmp = new Float32Array(a.length)
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0
        let c = 0
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy
          if (yy < 0 || yy >= h) continue
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx
            if (xx < 0 || xx >= w) continue
            s += a[yy * w + xx]
            c++
          }
        }
        tmp[y * w + x] = s / c
      }
    }
    a.set(tmp)
  }
}

// Bilinear sample of the flow field at analysis-grid cell (x, y), matching
// how the GPU samples it (texel centres at (i + 0.5) / n, clamped at edges).
function sampleFlow(flow: FlowField, x: number, y: number, gw: number, gh: number) {
  const fx = Math.min(flow.w - 1, Math.max(0, ((x + 0.5) / gw) * flow.w - 0.5))
  const fy = Math.min(flow.h - 1, Math.max(0, ((y + 0.5) / gh) * flow.h - 0.5))
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const x1 = Math.min(x0 + 1, flow.w - 1)
  const y1 = Math.min(y0 + 1, flow.h - 1)
  const tx = fx - x0
  const ty = fy - y0
  const at = (arr: Float32Array) =>
    arr[y0 * flow.w + x0] * (1 - tx) * (1 - ty) +
    arr[y0 * flow.w + x1] * tx * (1 - ty) +
    arr[y1 * flow.w + x0] * (1 - tx) * ty +
    arr[y1 * flow.w + x1] * tx * ty
  return { u: at(flow.u), v: at(flow.v) }
}

function sampleField(f: Field, x: number, y: number): number | null {
  if (x < 0 || y < 0 || x > f.w - 1 || y > f.h - 1) return null
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = Math.min(x0 + 1, f.w - 1)
  const y1 = Math.min(y0 + 1, f.h - 1)
  const tx = x - x0
  const ty = y - y0
  return (
    f.data[y0 * f.w + x0] * (1 - tx) * (1 - ty) +
    f.data[y0 * f.w + x1] * tx * (1 - ty) +
    f.data[y1 * f.w + x0] * (1 - tx) * ty +
    f.data[y1 * f.w + x1] * tx * ty
  )
}

// Intensity trend per interval, following the motion: how much each cell's
// level changed compared with where its rain was one interval earlier.
// Growth is weighted at half strength on purpose: forecasting studies find
// radar growth trends barely persist while decay does, and letting growth run
// blooms noise into big fake blobs.
export function estimateTrend(prev: Field, curr: Field, flow: FlowField, maxDelta: number): Field {
  const { w, h } = curr
  const data = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const f = sampleFlow(flow, x, y, w, h)
      const p = sampleField(prev, x - f.u, y - f.v)
      if (p === null) continue
      const d = curr.data[i] - p
      data[i] = Math.max(-maxDelta, Math.min(maxDelta, d > 0 ? d * 0.5 : d))
    }
  }
  smoothField(data, w, h, 3)
  return { data, w, h }
}
