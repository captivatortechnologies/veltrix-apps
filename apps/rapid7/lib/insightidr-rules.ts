// =============================================================================
// Rapid7 InsightIDR — Detection Rules domain helpers (SIEM Detection Rules API v1).
//
// Shared by both InsightIDR configuration types: rule exceptions are created
// under a parent detection rule, and rule settings modify a rule in place. Both
// address a rule by its portable NAME and resolve it to the environment-specific
// Rapid7 Resource Name (RRN) at deploy time via GET /idr/v1/rules.
// =============================================================================

import { insightIDRErrorMessage, type InsightIDRClient } from './insightidr'

/** Rule actions accepted by the Detection Rules API (shared with exceptions). */
export const RULE_ACTIONS = [
  'OFF',
  'TRACKS_NOTABLE_EVENTS',
  'CREATES_INVESTIGATIONS',
  'CREATES_ALERTS',
  'ASSESS_ACTIVITY',
] as const
export type RuleAction = (typeof RULE_ACTIONS)[number]

/** Priority levels accepted by the Detection Rules API (shared with exceptions). */
export const PRIORITY_LEVELS = ['INFO', 'INHERITED', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const
export type PriorityLevel = (typeof PRIORITY_LEVELS)[number]

export const RULES_PATH = '/idr/v1/rules'

/** A combined detection rule as returned by GET /idr/v1/rules. */
export interface LiveDetectionRule {
  rrn?: string
  rrn_revision?: string
  rule_set?: string
  obsolete?: boolean
  rule?: {
    name?: string
    rule_action?: string
    priority_level?: string
  }
}

/** The detection rule's display name (its portable identity). */
export function detectionRuleName(rule: LiveDetectionRule): string {
  return (rule.rule?.name ?? '').trim()
}

/** List every detection rule; throws on a non-OK response. */
export async function listDetectionRules(client: InsightIDRClient): Promise<LiveDetectionRule[]> {
  const res = await client.getAll<LiveDetectionRule>(RULES_PATH, { include_counts: 'NONE' })
  if (!res.ok) {
    throw new Error(
      `Failed to list detection rules: ${insightIDRErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

/**
 * Index live detection rules by lower-cased name. When two rules share a name
 * the first (non-obsolete preferred) wins — callers surface an ambiguity error
 * only when they need to write to a name that is not uniquely resolvable.
 */
export function indexRulesByName(rules: LiveDetectionRule[]): Map<string, LiveDetectionRule[]> {
  const byName = new Map<string, LiveDetectionRule[]>()
  for (const rule of rules) {
    const name = detectionRuleName(rule).toLowerCase()
    if (!name || !rule.rrn || rule.obsolete) continue
    const bucket = byName.get(name)
    if (bucket) bucket.push(rule)
    else byName.set(name, [rule])
  }
  return byName
}

/**
 * Resolve one detection rule by name. Returns the rule, or a reason it could not
 * be resolved (missing / ambiguous) so callers can report it per-item.
 */
export function resolveRuleByName(
  byName: Map<string, LiveDetectionRule[]>,
  name: string,
): { rule: LiveDetectionRule } | { error: string } {
  const matches = byName.get(name.trim().toLowerCase())
  if (!matches || matches.length === 0) {
    return { error: `No detection rule named "${name}" was found in this InsightIDR organization` }
  }
  if (matches.length > 1) {
    return { error: `Detection rule name "${name}" is ambiguous — ${matches.length} rules share it` }
  }
  return { rule: matches[0] }
}
