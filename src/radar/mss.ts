// MSS rain-area radar facts shared by the map and the weather companion's
// server function, so both read the same scans the same way. Plain data and
// maths only: no Leaflet or DOM, so it also runs on the server.

import type { FlowSourceConfig, SteeringWind } from './motion.ts'

// Bounding box of MSS's own rain-area radar composite (same source their site embeds).
export const MSS_SOUTH_WEST: [number, number] = [1.156, 103.565]
export const MSS_NORTH_EAST: [number, number] = [1.475, 104.13]

// MSS publishes a scan every 5 minutes.
export const MSS_STEP_MINUTES = 5

// Motion-analysis tuning per source. MSS images are 217x120px over ~63x35km
// (~0.3km/px) with a scan every 5 min; RainViewer's window is 768px over
// ~470km (~0.6km/px) every 10 min. Analysis cells end up ~0.6km (MSS) and
// ~2.4km (RainViewer), and search radii cover storm motion up to roughly
// 40km/h either side of the steering-wind first guess.
export const MSS_FLOW_CONFIG: FlowSourceConfig = {
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

export function floorToSgFiveMin(epoch: number) {
  const sgMs = epoch + 8 * 3600 * 1000
  const flooredSg = Math.floor(sgMs / (5 * 60 * 1000)) * 5 * 60 * 1000
  return flooredSg - 8 * 3600 * 1000
}

export function mssImagePath(epoch: number) {
  const { y, mo, da, h, mi } = sgFields(epoch)
  const dt = `${y}${pad(mo)}${pad(da)}${pad(h)}${pad(mi)}`
  return `/50km/v2/dpsri_70km_${dt}0000dBR.dpsri.png`
}

export function mssImageUrl(epoch: number) {
  return `https://www.weather.gov.sg/files/rainarea${mssImagePath(epoch)}`
}

// Rain cells are carried by the wind 1.5-3km up, not the surface wind the
// weather stations measure (which is slowed and turned by friction, and
// often points a different way entirely). Open-Meteo's 850/700 hPa model wind
// over Singapore is the standard "steering flow" first guess for storm motion.
export const STEERING_API =
  'https://api.open-meteo.com/v1/forecast?latitude=1.35&longitude=103.82' +
  '&hourly=wind_speed_850hPa,wind_direction_850hPa,wind_speed_700hPa,wind_direction_700hPa' +
  '&past_hours=2&forecast_hours=4&timezone=UTC'

// The steering wind for the hour nearest `now` from a STEERING_API response:
// the vector mean of the 850 and 700 hPa winds, as east/north km/h.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function steeringFromResponse(json: any, now: number): SteeringWind | null {
  const h = json.hourly
  const times: number[] = h.time.map((t: string) => Date.parse(`${t}Z`))
  let best = 0
  for (let i = 1; i < times.length; i++) {
    if (Math.abs(times[i] - now) < Math.abs(times[best] - now)) best = i
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
}
