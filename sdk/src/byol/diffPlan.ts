// =============================================================================
// BYOL plan diff (pure, React-free).
//
// Terraform-style "what will change" arithmetic: given the CURRENT persisted
// resource rows and the DESIRED plan derived from topology, classify every
// resource by `planKey` into add / change / destroy / noop. This is the exact,
// non-mutating mirror of the set arithmetic `seedResources` performs when it
// persists a plan (delete rows not in the plan + upsert the rest) — so a Plan
// preview and the subsequent Apply agree by construction.
//
// It is the single source of truth for the Plan → Apply UX:
//   • the app SERVER computes it for `GET /byol/:id/plan` (a side-effect-free
//     dry-run), returning `buildByolPlan(current, desired)`, and
//   • the SDK renders the returned `ByolPlan` in the Plan modal.
//
// Kept React-free (no imports beyond the topology tier order) so it can run on
// either side. NOTE: like the topology, the app server keeps its OWN copy
// (apps/<id>/lib/byolPlanDiff.ts) rather than importing this at runtime — an app
// must not depend on a root/byol SDK export that may be absent in the pinned
// @veltrixsecops/app-sdk version. Keep the two in sync.
// =============================================================================

import { TIER_ORDER } from './topology'
import type { ByolTags } from './tags'

/** A single resource's disposition in a plan. */
export type PlanAction = 'add' | 'change' | 'destroy' | 'noop'

/** The minimal shape of a CURRENT persisted resource row diffPlan compares. */
export interface PlanDiffCurrent {
  planKey: string
  tier: string
  kind: string
  name: string
  role: string | null
  region: string | null
  /** A `failed`/`attention` row is always re-planned as a change. */
  status?: string
}

/** The minimal shape of a DESIRED topology plan item diffPlan compares. */
export interface PlanDiffDesired {
  planKey: string
  tier: string
  kind: string
  name: string
  role: string | null
  region: string | null
  sortOrder?: number
}

/** The four buckets of a diff, keyed by `planKey`. add/change/noop hold the
 *  desired item (the target state); destroy holds the current row being removed. */
export interface PlanDiff {
  add: PlanDiffDesired[]
  change: PlanDiffDesired[]
  destroy: PlanDiffCurrent[]
  noop: PlanDiffDesired[]
}

/** Count of each action — the header summary of the Plan modal. */
export interface ByolPlanSummary {
  add: number
  change: number
  destroy: number
  noop: number
}

/** One resource line in the plan, tagged with its action for the modal. */
export interface ByolPlanItem {
  planKey: string
  action: PlanAction
  name: string
  role: string | null
  region: string | null
  kind: string
}

/** Plan lines grouped by tier, in provisioning order. */
export interface ByolPlanGroup {
  tier: string
  items: ByolPlanItem[]
}

/** The subnet the platform network allocator previewed / reserved for a stack. */
export interface ByolPlanNetwork {
  /** Opaque handle to the shared per-(provider,region) Network (VPC/VNet/…). */
  networkRef: string
  /** The /24 subnet CIDR carved for this stack, e.g. `10.20.4.0/24`. */
  subnetCidr: string
}

/**
 * The full `GET /byol/:id/plan` response contract.
 *
 * The core diff (`summary` + `groups`) is computed by `buildByolPlan`; the app
 * server ENRICHES the response with `network` (a dry-run subnet peek) + `tags`
 * (the canonical tenant/cost tag set). Both are optional so the modal degrades
 * gracefully: `networkUnavailable` flags that the allocator was unreachable, and
 * `network` is simply absent for a self-hosted stack where it does not apply.
 */
export interface ByolPlan {
  summary: ByolPlanSummary
  groups: ByolPlanGroup[]
  /** Subnet the allocator would carve for this stack (peek), when applicable. */
  network?: ByolPlanNetwork
  /** Canonical tenant / cost-allocation tags every resource will carry. */
  tags?: ByolTags
  /** Soft flag: the network allocator was unreachable, so `network` is absent. */
  networkUnavailable?: boolean
}

const nz = (v: string | null | undefined): string | null => (v == null ? null : v)

/** True when a current row's identifying fields differ from the desired item. */
function differs(current: PlanDiffCurrent, desired: PlanDiffDesired): boolean {
  return (
    current.tier !== desired.tier ||
    current.kind !== desired.kind ||
    current.name !== desired.name ||
    nz(current.role) !== nz(desired.role) ||
    nz(current.region) !== nz(desired.region)
  )
}

/** A row that failed / needs attention is re-planned (Retry re-provisions it). */
function needsReplan(status?: string): boolean {
  return status === 'failed' || status === 'attention'
}

/**
 * Diff the desired topology plan against the current persisted rows.
 *
 *  • add     — desired keys with no current row
 *  • change  — desired keys whose current row differs (tier/kind/name/role/
 *              region) or is failed/attention
 *  • destroy — current rows whose key is no longer desired
 *  • noop    — desired keys whose current row already matches
 *
 * Pure and non-mutating: it never touches its inputs.
 */
export function diffPlan(current: PlanDiffCurrent[], desired: PlanDiffDesired[]): PlanDiff {
  const currentByKey = new Map(current.map((c) => [c.planKey, c]))
  const desiredKeys = new Set(desired.map((d) => d.planKey))

  const add: PlanDiffDesired[] = []
  const change: PlanDiffDesired[] = []
  const noop: PlanDiffDesired[] = []

  for (const item of desired) {
    const existing = currentByKey.get(item.planKey)
    if (!existing) add.push(item)
    else if (differs(existing, item) || needsReplan(existing.status)) change.push(item)
    else noop.push(item)
  }

  const destroy = current.filter((c) => !desiredKeys.has(c.planKey))

  return { add, change, destroy, noop }
}

/** Order a tier by its provisioning position (unknown tiers sort last). */
function tierRank(tier: string): number {
  const idx = (TIER_ORDER as readonly string[]).indexOf(tier)
  return idx === -1 ? TIER_ORDER.length : idx
}

/**
 * Compute the full plan response from current + desired: the action counts plus
 * every resource line grouped by tier in provisioning order. Destroyed rows are
 * appended within their tier (they retain their tier but not a desired order).
 */
export function buildByolPlan(current: PlanDiffCurrent[], desired: PlanDiffDesired[]): ByolPlan {
  const diff = diffPlan(current, desired)
  const summary: ByolPlanSummary = {
    add: diff.add.length,
    change: diff.change.length,
    destroy: diff.destroy.length,
    noop: diff.noop.length,
  }

  const action = new Map<string, PlanAction>()
  for (const d of diff.add) action.set(d.planKey, 'add')
  for (const d of diff.change) action.set(d.planKey, 'change')
  for (const d of diff.noop) action.set(d.planKey, 'noop')

  type Ranked = ByolPlanItem & { tier: string; rank: number }
  const lines: Ranked[] = []

  desired.forEach((d, i) => {
    lines.push({
      tier: d.tier,
      rank: d.sortOrder ?? i,
      planKey: d.planKey,
      action: action.get(d.planKey) ?? 'noop',
      name: d.name,
      role: nz(d.role),
      region: nz(d.region),
      kind: d.kind,
    })
  })
  // Destroyed rows have no desired order; place them after the desired items.
  const tail = desired.length
  diff.destroy.forEach((c, i) => {
    lines.push({
      tier: c.tier,
      rank: tail + i,
      planKey: c.planKey,
      action: 'destroy',
      name: c.name,
      role: nz(c.role),
      region: nz(c.region),
      kind: c.kind,
    })
  })

  lines.sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || a.rank - b.rank)

  const groups: ByolPlanGroup[] = []
  const byTier = new Map<string, ByolPlanGroup>()
  for (const line of lines) {
    let group = byTier.get(line.tier)
    if (!group) {
      group = { tier: line.tier, items: [] }
      byTier.set(line.tier, group)
      groups.push(group)
    }
    group.items.push({
      planKey: line.planKey,
      action: line.action,
      name: line.name,
      role: line.role,
      region: line.region,
      kind: line.kind,
    })
  }

  return { summary, groups }
}

/** Whether a plan has any actionable change (drives the modal's Apply gate). */
export function planHasChanges(summary: ByolPlanSummary): boolean {
  return summary.add + summary.change + summary.destroy > 0
}
