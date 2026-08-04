// Shared helpers for the Semgrep Remediation Policies config type (validate +
// deploy + rollback + drift).
//
// The declared item LIST is the deployment's WHOLE remediation-policies bundle —
// applied via the Policies V2 [Beta] API:
//   GET  /api/policies/v2/deployments/{deploymentId}/remediation-policies
//   PUT  /api/policies/v2/deployments/{deploymentId}/remediation-policies
//        (strict apply — the submitted list REPLACES the current state;
//        policies absent from it are DELETED; requires If-Match: state_version)
//   POST /api/policies/v2/deployments/{deploymentId}/remediation-policies:dryRun
//        (preview — validates + diffs without changing anything)
//
// System-managed policies never appear in the bundle and are never affected by
// an apply. Identity is the policy SLUG — required here (never left to be
// server-derived from name, unlike the raw API which allows that) so canvas
// identity stays stable across renames.
//
// filters.conditions and actions are inherently nested lists of typed objects,
// which the canvas has no first-class field for (the same constraint cisco-
// meraki's Group Policies / L7 rule "value" object hit) — declared as JSON
// arrays in a textarea, structurally validated in validate.ts and, live,
// against Semgrep's own dry-run validator (companion-action requirements like
// "block requires pr_comment" are enforced server-side, not duplicated here).

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import { canvasItems, readBool } from '../../lib/canvas'
import type { RemediationPolicy, RemediationPolicyAction, RemediationPolicyCondition } from '../../lib/semgrepApi'

export interface RemediationPolicySpec {
  slug: string
  name: string
  description: string
  active: boolean
  filterMode: string
  /** Parsed conditions, or null when the canvas JSON failed to parse. */
  conditions: RemediationPolicyCondition[] | null
  /** Parsed actions, or null when the canvas JSON failed to parse. */
  actions: RemediationPolicyAction[] | null
}

function parseArray<T>(raw: string): T[] | null {
  const trimmed = raw.trim()
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed)
    return Array.isArray(parsed) ? (parsed as T[]) : null
  } catch {
    return null
  }
}

export function remediationPolicySpecFromFields(fields: Record<string, unknown>): RemediationPolicySpec {
  return {
    slug: String(fields.slug ?? '').trim(),
    name: String(fields.name ?? '').trim(),
    description: String(fields.description ?? '').trim(),
    active: readBool(fields.active, true),
    filterMode: String(fields.filterMode ?? 'all').trim().toLowerCase(),
    conditions: parseArray<RemediationPolicyCondition>(String(fields.conditionsJson ?? '')),
    actions: parseArray<RemediationPolicyAction>(String(fields.actionsJson ?? '')),
  }
}

/** Every Remediation Policy spec authored on the canvas. */
export function extractRemediationPolicySpecs(canvas: CanvasSnapshot): RemediationPolicySpec[] {
  return canvasItems(canvas).map((item) => remediationPolicySpecFromFields(item.fields ?? {}))
}

/** Whether a spec parsed cleanly enough to include in an applied bundle. */
export function isCompleteSpec(spec: RemediationPolicySpec): boolean {
  return Boolean(spec.slug && spec.name && spec.conditions !== null && spec.actions !== null)
}

/** Map one spec onto the API's RemediationPolicy shape. */
export function policyFromSpec(spec: RemediationPolicySpec): RemediationPolicy {
  return {
    slug: spec.slug,
    name: spec.name,
    description: spec.description || undefined,
    active: spec.active,
    filters: { mode: (spec.filterMode as 'all' | 'any') ?? 'all', conditions: spec.conditions ?? [] },
    actions: spec.actions ?? [],
  }
}

/** The full declared bundle — every complete spec, in the shape the whole-list PUT expects. */
export function bundleFromSpecs(specs: RemediationPolicySpec[]): { policies: RemediationPolicy[] } {
  return { policies: specs.filter(isCompleteSpec).map(policyFromSpec) }
}

function normalizePolicy(p: RemediationPolicy): unknown {
  return {
    name: p.name,
    description: p.description ?? '',
    active: p.active ?? true,
    filters: {
      mode: p.filters?.mode,
      conditions: [...(p.filters?.conditions ?? [])]
        .map((c) => ({ type: c.type, values: [...(c.values ?? [])].sort(), mode: c.mode ?? 'any' }))
        .sort((x, y) => x.type.localeCompare(y.type)),
    },
    actions: [...(p.actions ?? [])]
      .map((act) => ({ type: act.type, config: act.config ?? {} }))
      .sort((x, y) => x.type.localeCompare(y.type)),
  }
}

/** Whether two remediation policies declare the same content (identity — slug — assumed equal already). */
export function policiesEqual(a: RemediationPolicy, b: RemediationPolicy): boolean {
  return JSON.stringify(normalizePolicy(a)) === JSON.stringify(normalizePolicy(b))
}
