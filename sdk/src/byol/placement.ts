// =============================================================================
// Cluster placement: percent → integer node allocation.
//
// Shared by the topology builder (derives per-node site assignment) and the
// form (live "→ N nodes" preview) so both agree exactly. Only the indexer and
// search-head tiers use this; every other tier is single-site (main region).
// =============================================================================

import type { ClusterPlacement, PlacementSite } from './types'

export interface SiteAllocation {
  site: string
  count: number
  /** The requested percent for this site (echoed for display / audit). */
  percent: number
}

/**
 * Allocate `totalNodes` across a cluster's sites by percent.
 *
 * Rules:
 *  - Every listed site receives at least one node (a site in the plan must be real).
 *  - The remaining nodes are distributed by percent using the largest-remainder
 *    method, so the counts sum to exactly `totalNodes`.
 *  - Deterministic: ties in the remainder are broken by site order (no RNG).
 *
 * Callers must ensure `sites.length <= totalNodes` (see {@link validatePlacement});
 * when that does not hold this still returns one node per site until it runs out,
 * so it never returns a negative count.
 */
export function allocateNodesBySite(totalNodes: number, sites: PlacementSite[]): SiteAllocation[] {
  const n = Math.max(0, Math.floor(totalNodes))
  const list = sites ?? []
  if (list.length === 0) return []

  // Floor of one per site, capped at the node budget.
  const base = list.map(() => 0)
  let assigned = 0
  for (let i = 0; i < list.length && assigned < n; i++) {
    base[i] = 1
    assigned++
  }

  const remaining = n - assigned
  if (remaining > 0) {
    // Largest-remainder distribution of the remaining nodes by percent.
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

/**
 * Validate a cluster placement against a node count. Returns a human-readable
 * error string, or `null` when the placement is deployable.
 */
export function validatePlacement(placement: ClusterPlacement | undefined, totalNodes: number): string | null {
  if (!placement || placement.mode === 'single') return null
  const sites = placement.sites ?? []
  if (sites.length < 2) return 'Multi-site placement needs at least two sites.'

  const seen = new Set<string>()
  for (const s of sites) {
    if (!s.site || !s.site.trim()) return 'Every site must be selected.'
    if (seen.has(s.site)) return `Site "${s.site}" is listed more than once.`
    seen.add(s.site)
    if (!(s.percent > 0)) return `Site "${s.site}" must have a percent greater than zero.`
  }

  const sumPercent = sites.reduce((sum, s) => sum + s.percent, 0)
  if (Math.round(sumPercent) !== 100) return `Site percentages must total 100 (currently ${Math.round(sumPercent)}).`

  if (sites.length > Math.floor(totalNodes)) {
    return `Too many sites (${sites.length}) for ${totalNodes} node${totalNodes === 1 ? '' : 's'} — each site needs at least one node.`
  }
  return null
}

/**
 * Resolve the placement actually used for a tier: multi-site placement is only
 * honored for eligible (indexer / search-head) tiers; everything else collapses
 * to single-site so callers can treat the result uniformly.
 */
export function effectivePlacement(placement: ClusterPlacement | undefined, eligible: boolean): ClusterPlacement {
  if (!eligible || !placement || placement.mode !== 'multi-site') return { mode: 'single' }
  if (!placement.sites || placement.sites.length < 2) return { mode: 'single' }
  return placement
}
