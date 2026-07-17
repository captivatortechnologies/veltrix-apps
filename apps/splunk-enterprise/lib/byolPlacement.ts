// =============================================================================
// Cluster placement + control-plane layout (app-owned, pure, dependency-free).
//
// Mirrors the SDK's `byol/placement.ts` + the placement/layout types in
// `byol/types.ts`. The app SERVER keeps its own copy for the same reason as
// `byolTopology.ts`: it must not depend on an SDK export that may be absent in
// whatever @veltrixsecops/app-sdk version the platform packages the app against.
// Keep the two in sync.
// =============================================================================

/** Control-plane consolidation layout — combines management roles onto fewer instances. */
export type ControlPlaneLayout = 'dedicated' | 'consolidated' | 'single'

/** How a cluster's sites are addressed: availability zones (same region) or regions. */
export type PlacementGranularity = 'az' | 'region'

/** One placement target with its share of a cluster's nodes. */
export interface PlacementSite {
  site: string
  percent: number
}

/** Placement of a single cluster tier (indexer / search-head only). */
export interface ClusterPlacement {
  mode: 'single' | 'multi-site'
  granularity?: PlacementGranularity
  sites?: PlacementSite[]
}

export interface SiteAllocation {
  site: string
  count: number
  percent: number
}

export const MIN_HEAVY_FORWARDERS = 1
export const CONTROL_PLANE_LAYOUTS: ControlPlaneLayout[] = ['dedicated', 'consolidated', 'single']

/** Coerce an unknown value to a valid control-plane layout, defaulting to 'dedicated'. */
export function normalizeControlPlaneLayout(value: unknown): ControlPlaneLayout {
  return CONTROL_PLANE_LAYOUTS.includes(value as ControlPlaneLayout)
    ? (value as ControlPlaneLayout)
    : 'dedicated'
}

/**
 * Allocate `totalNodes` across a cluster's sites by percent (largest-remainder,
 * floor of one per site, deterministic tie-break by order). Sums to totalNodes.
 */
export function allocateNodesBySite(totalNodes: number, sites: PlacementSite[]): SiteAllocation[] {
  const n = Math.max(0, Math.floor(totalNodes))
  const list = sites ?? []
  if (list.length === 0) return []

  const base = list.map(() => 0)
  let assigned = 0
  for (let i = 0; i < list.length && assigned < n; i++) {
    base[i] = 1
    assigned++
  }

  const remaining = n - assigned
  if (remaining > 0) {
    const totalPercent = list.reduce((sum, s) => sum + Math.max(0, s.percent), 0) || 1
    const ideal = list.map((s) => (Math.max(0, s.percent) / totalPercent) * remaining)
    const floors = ideal.map((v) => Math.floor(v))
    let leftover = remaining - floors.reduce((a, b) => a + b, 0)
    const order = list
      .map((_, i) => ({ i, frac: ideal[i] - floors[i] }))
      .sort((a, b) => b.frac - a.frac || a.i - b.i)
    for (let k = 0; k < order.length && leftover > 0; k++) {
      floors[order[k].i]++
      leftover--
    }
    for (let i = 0; i < list.length; i++) base[i] += floors[i]
  }

  return list.map((s, i) => ({ site: s.site, count: base[i], percent: s.percent }))
}

/** Validate a placement against a node count. Returns an error string or null. */
export function validatePlacement(placement: ClusterPlacement | undefined | null, totalNodes: number): string | null {
  if (!placement || placement.mode === 'single') return null
  const sites = placement.sites ?? []
  if (sites.length < 2) return 'Multi-site placement needs at least two sites.'

  const seen = new Set<string>()
  for (const s of sites) {
    if (!s.site || !String(s.site).trim()) return 'Every site must be selected.'
    if (seen.has(s.site)) return `Site "${s.site}" is listed more than once.`
    seen.add(s.site)
    if (!(s.percent > 0)) return `Site "${s.site}" must have a percent greater than zero.`
  }

  const sumPercent = sites.reduce((sum, s) => sum + s.percent, 0)
  if (Math.round(sumPercent) !== 100) return `Site percentages must total 100 (currently ${Math.round(sumPercent)}).`

  if (sites.length > Math.floor(totalNodes)) {
    return `Too many sites (${sites.length}) for ${totalNodes} node${totalNodes === 1 ? '' : 's'}.`
  }
  return null
}

/**
 * Resolve the placement actually used for a tier: multi-site is honored only for
 * eligible (indexer / search-head) tiers; everything else collapses to single-site.
 */
export function effectivePlacement(placement: ClusterPlacement | undefined | null, eligible: boolean): ClusterPlacement {
  if (!eligible || !placement || placement.mode !== 'multi-site') return { mode: 'single' }
  if (!placement.sites || placement.sites.length < 2) return { mode: 'single' }
  return placement
}

/**
 * Parse a persisted JSONB placement value (object from the pg driver, or a JSON
 * string) into a `ClusterPlacement`, or null when absent / malformed.
 */
export function parsePlacement(value: unknown): ClusterPlacement | null {
  if (value == null) return null
  let obj: any = value
  if (typeof value === 'string') {
    try {
      obj = JSON.parse(value)
    } catch {
      return null
    }
  }
  if (!obj || typeof obj !== 'object') return null
  if (obj.mode !== 'single' && obj.mode !== 'multi-site') return null
  const sites = Array.isArray(obj.sites)
    ? obj.sites
        .filter((s: any) => s && typeof s.site === 'string')
        .map((s: any) => ({ site: s.site, percent: Number(s.percent) || 0 }))
    : undefined
  const placement: ClusterPlacement = { mode: obj.mode }
  if (obj.granularity === 'az' || obj.granularity === 'region') placement.granularity = obj.granularity
  if (sites) placement.sites = sites
  return placement
}
