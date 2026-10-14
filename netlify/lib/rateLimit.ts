// Per-visitor limits for the weather companion, so one person or bot can't
// burn through the shared free Groq quota. Netlify's own rate limiter (set in
// the function's config) blocks bursts at the edge across every instance;
// this adds what it can't express: an hourly cap, and one question in flight
// per visitor. Counters live in memory, so they're per warm function instance
// and reset on a cold start: a second line of defence, not the only one. It's
// also the only limiter in `npm run dev`.

const MINUTE = 60_000
const HOUR = 60 * MINUTE

export const LIMITS = { perMinute: 5, perHour: 30 }
// Netlify ends a function at 60s, so a request "in flight" longer than this
// never released its slot (e.g. the stream died) and shouldn't block anyone.
const STALE_IN_FLIGHT_MS = 70_000

type Visitor = { hits: number[]; inFlightSince: number | null }
const visitors = new Map<string, Visitor>()
let lastSweep = 0

function sweep(now: number) {
  if (now - lastSweep < MINUTE) return
  lastSweep = now
  for (const [ip, v] of visitors) {
    v.hits = v.hits.filter((t) => now - t < HOUR)
    if (v.inFlightSince !== null && now - v.inFlightSince >= STALE_IN_FLIGHT_MS) v.inFlightSince = null
    if (v.hits.length === 0 && v.inFlightSince === null) visitors.delete(ip)
  }
}

export type LimitResult = { ok: true; release: () => void } | { ok: false; retryAfterSec: number; message: string }

// Admits one request from `ip`, or says how long until it would be. Call
// `release` when the request finishes.
export function admit(ip: string, now = Date.now()): LimitResult {
  sweep(now)
  const v = visitors.get(ip) ?? { hits: [], inFlightSince: null }
  visitors.set(ip, v)
  v.hits = v.hits.filter((t) => now - t < HOUR)
  if (v.inFlightSince !== null && now - v.inFlightSince < STALE_IN_FLIGHT_MS) {
    return { ok: false, retryAfterSec: 5, message: 'Wait for the current answer to finish first.' }
  }
  const lastMinute = v.hits.filter((t) => now - t < MINUTE)
  if (lastMinute.length >= LIMITS.perMinute) {
    return {
      ok: false,
      retryAfterSec: Math.ceil((lastMinute[0] + MINUTE - now) / 1000),
      message: "You're asking a lot at once. Try again in a minute.",
    }
  }
  if (v.hits.length >= LIMITS.perHour) {
    return {
      ok: false,
      retryAfterSec: Math.ceil((v.hits[0] + HOUR - now) / 1000),
      message: "You've hit the hourly question limit. Try again later.",
    }
  }
  v.hits.push(now)
  v.inFlightSince = now
  let released = false
  return {
    ok: true,
    release: () => {
      if (released) return
      released = true
      if (v.inFlightSince === now) v.inFlightSince = null
    },
  }
}
