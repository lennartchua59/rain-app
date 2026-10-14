// Forecast scorekeeping. Each time a new latest scan arrives, the forecast
// for +15/+30/+60 min is saved as a rain/no-rain mask; once a real scan for
// that time loads, the two are compared. Everything lives in this browser's
// localStorage, so it builds up on whichever device the app is opened on.

import { sampleField, sampleFlow, type Field, type FlowField } from './motion'

export const VERIFY_LEADS = [15, 30, 60] as const
export type VerifySource = 'mss' | 'rainviewer'

// Analysis-grid level that counts as "raining" (same cut the motion code uses).
const RAIN_LEVEL = 0.5

// How close a real scan must be to a forecast's valid time to score it.
const MATCH_TOLERANCE_MS: Record<VerifySource, number> = { mss: 2.5 * 60_000, rainviewer: 5 * 60_000 }

// Too little rain in both forecast and reality says nothing about skill.
const MIN_EVENT_CELLS = 5

const PENDING_KEY = 'rain-verify-pending-v1'
const RESULTS_KEY = 'rain-verify-results-v1'
const MAX_RESULTS = 3000

type Pending = {
  src: VerifySource
  issued: number
  motion: string
  w: number
  h: number
  latest: string
  fc: Record<number, string>
  done: number[]
}

export type VerifyResult = {
  src: VerifySource
  issued: number
  lead: number
  motion: string
  // Cell counts: forecast rain that happened, rain that was missed, forecast
  // rain that didn't happen. Same three for "nothing moves" (persistence).
  hit: number
  miss: number
  fa: number
  pHit: number
  pMiss: number
  pFa: number
}

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage full or blocked: scoring is a nice-to-have, never break the map.
  }
}

function packMask(mask: Uint8Array): string {
  const bytes = new Uint8Array(Math.ceil(mask.length / 8))
  for (let i = 0; i < mask.length; i++) if (mask[i]) bytes[i >> 3] |= 1 << (i & 7)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function unpackMask(packed: string, n: number): Uint8Array {
  const s = atob(packed)
  const mask = new Uint8Array(n)
  for (let i = 0; i < n; i++) mask[i] = (s.charCodeAt(i >> 3) >> (i & 7)) & 1
  return mask
}

function rainMask(f: Field): Uint8Array {
  const m = new Uint8Array(f.data.length)
  for (let i = 0; i < m.length; i++) m[i] = f.data[i] >= RAIN_LEVEL ? 1 : 0
  return m
}

// CPU copy of the map's forecast step (flowRenderer's extrapolate mode):
// trace each cell back along the motion, keep what's there now where the
// trace leaves the image, then add the growth/decay trend. The on-screen
// lead-time softening is left out, since it only blurs edges.
function forecastMask(latest: Field, flow: FlowField, trend: Field | null, steps: number, trendGain: number) {
  const { w, h } = latest
  const m = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let px = x
      let py = y
      for (let i = 0; i < 6; i++) {
        const f = sampleFlow(flow, px, py, w, h)
        px -= (f.u * steps) / 6
        py -= (f.v * steps) / 6
      }
      if (px < 0 || py < 0 || px > w - 1 || py > h - 1) {
        px = x
        py = y
      }
      let level = sampleField(latest, px, py) ?? 0
      if (level > 0 && trend) level += (sampleField(trend, px, py) ?? 0) * trendGain
      m[y * w + x] = level >= RAIN_LEVEL ? 1 : 0
    }
  }
  return m
}

export function recordForecast({
  src,
  issued,
  latest,
  flow,
  trend,
  dtMinutes,
  motion,
  trendTau,
}: {
  src: VerifySource
  issued: number
  latest: Field
  flow: FlowField
  trend: Field | null
  dtMinutes: number
  motion: string
  trendTau: number
}) {
  const pending = load<Pending[]>(PENDING_KEY, [])
  if (pending.some((p) => p.src === src && p.issued === issued)) return
  const fc: Record<number, string> = {}
  for (const lead of VERIFY_LEADS) {
    const steps = lead / dtMinutes
    const gain = trendTau * (1 - Math.exp(-steps / trendTau))
    fc[lead] = packMask(forecastMask(latest, flow, trend, steps, gain))
  }
  pending.push({ src, issued, motion, w: latest.w, h: latest.h, latest: packMask(rainMask(latest)), fc, done: [] })
  // Anything older than the longest lead plus a margin can no longer be matched.
  const cutoff = Date.now() - (Math.max(...VERIFY_LEADS) + 90) * 60_000
  save(
    PENDING_KEY,
    pending.filter((p) => p.issued >= cutoff),
  )
}

// Scores any saved forecast whose valid time matches this real scan.
export function verifyAgainst(src: VerifySource, time: number, observed: Field) {
  const pending = load<Pending[]>(PENDING_KEY, [])
  if (pending.length === 0) return
  const results = load<VerifyResult[]>(RESULTS_KEY, [])
  let changed = false
  const obs = rainMask(observed)
  for (const p of pending) {
    if (p.src !== src || p.w !== observed.w || p.h !== observed.h) continue
    for (const lead of VERIFY_LEADS) {
      if (p.done.includes(lead)) continue
      if (Math.abs(p.issued + lead * 60_000 - time) > MATCH_TOLERANCE_MS[src]) continue
      p.done.push(lead)
      changed = true
      const n = p.w * p.h
      const fc = unpackMask(p.fc[lead], n)
      const per = unpackMask(p.latest, n)
      const r: VerifyResult = { src, issued: p.issued, lead, motion: p.motion, hit: 0, miss: 0, fa: 0, pHit: 0, pMiss: 0, pFa: 0 }
      for (let i = 0; i < n; i++) {
        if (fc[i] && obs[i]) r.hit++
        else if (obs[i]) r.miss++
        else if (fc[i]) r.fa++
        if (per[i] && obs[i]) r.pHit++
        else if (obs[i]) r.pMiss++
        else if (per[i]) r.pFa++
      }
      if (r.hit + r.miss + r.fa >= MIN_EVENT_CELLS) results.push(r)
    }
  }
  if (!changed) return
  save(PENDING_KEY, pending)
  save(RESULTS_KEY, results.slice(-MAX_RESULTS))
}

export type LeadSummary = {
  lead: number
  cases: number
  // Critical success index: hits / (hits + misses + false alarms). 1 is perfect.
  csi: number
  // Same score for "assume nothing moves", the bar a forecast has to beat.
  persistenceCsi: number
  // Share of real rain the forecast caught, and share of forecast rain that was wrong.
  pod: number
  far: number
}

export function summarize(src: VerifySource, sinceMs = 0): LeadSummary[] {
  const results = load<VerifyResult[]>(RESULTS_KEY, []).filter((r) => r.src === src && r.issued >= sinceMs)
  return VERIFY_LEADS.map((lead) => {
    const rs = results.filter((r) => r.lead === lead)
    const sum = (k: keyof VerifyResult) => rs.reduce((a, r) => a + (r[k] as number), 0)
    const hit = sum('hit')
    const miss = sum('miss')
    const fa = sum('fa')
    const pHit = sum('pHit')
    const pMiss = sum('pMiss')
    const pFa = sum('pFa')
    const ratio = (a: number, b: number) => (b > 0 ? a / b : 0)
    return {
      lead,
      cases: rs.length,
      csi: ratio(hit, hit + miss + fa),
      persistenceCsi: ratio(pHit, pHit + pMiss + pFa),
      pod: ratio(hit, hit + miss),
      far: ratio(fa, hit + fa),
    }
  })
}

export function clearVerification() {
  try {
    localStorage.removeItem(PENDING_KEY)
    localStorage.removeItem(RESULTS_KEY)
  } catch {
    // Nothing to clear.
  }
}
