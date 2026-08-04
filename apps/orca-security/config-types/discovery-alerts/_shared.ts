// Shared helpers for the Orca Discovery Alerts config type (deploy + rollback +
// drift).
//
// Orca discovery-based custom alerts share the SAME base resource as Custom
// Alerts (/api/sonar/rules) but are driven by a Discovery (graph) query
// (`rule_json`, a JSON object) instead of a Sonar (DSL) string (`rule`), and
// carry an optional compliance-framework association (VERIFIED against
// terraform-provider-orcasecurity api_client/custom_discovery_alert.go):
//   POST   /api/sonar/rules          create; returns { data: { rule_id, rule_type, ... } }
//   GET    /api/sonar/rules/{id}      read;   returns { data: { ... } }
//   PUT    /api/sonar/rules/{id}      update
//   DELETE /api/sonar/rules/{id}      delete
//
// Two verified, honest differences from Custom Alerts:
//   - The API payload has NO `enabled` field for this resource — a discovery
//     alert cannot be toggled through this endpoint, only its content edited.
//   - `remediation_text` is managed through a SEPARATE, second API
//     (GET/PUT/POST/DELETE /api/alerts/custom_remediation_text, keyed by the
//     server-computed `rule_type`) rather than the primary create/update body.
//     This app does not manage it — see canvas.yaml / README Coverage.
//
// The Go client also always serializes an empty `negation` field on every
// request (no `omitempty` on that struct field); this app mirrors that for
// wire fidelity even though its purpose is undocumented outside Orca-internal
// use — treat it as a required-but-inert field, not a user setting.

import { normalizeBool, type ReconcileData, type ReconcileEntry } from '../../lib/reconcile'

/** Valid Orca alert categories (mirrors config-types/custom-alerts/_shared.ts and canvas.yaml options). */
export const CATEGORIES = new Set<string>([
  'Access control',
  'Authentication',
  'Best practices',
  'Data at risk',
  'Data protection',
  'IAM misconfigurations',
  'Lateral movement',
  'Logging and monitoring',
  'Malicious activity',
  'Malware',
  'Neglected assets',
  'Network misconfigurations',
  'Source code vulnerabilities',
  'Suspicious activity',
  'System integrity',
  'Vendor services misconfigurations',
  'Vulnerabilities',
  'Workload misconfigurations',
])

/** Valid compliance-framework control priorities (mirrors canvas.yaml). */
export const PRIORITIES = new Set<string>(['high', 'medium', 'low'])

export const MIN_SCORE = 1
export const MAX_SCORE = 10

/** One compliance-framework association, in the UI-friendly shape this canvas authors. */
export interface ComplianceFrameworkRef {
  name: string
  /** "/"-joined path, up to 3 levels, e.g. "Identify/Risk Assessment/Vulnerabilities". */
  section: string
  priority: string
}

/** The same association in the wire shape the Orca API expects. */
export interface ApiComplianceFrameworkRef {
  compliance_framework: string
  category: string
  sub_category?: string
  sub_sub_category?: string
  priority: string
}

/** One Orca discovery alert (the `data` payload of /api/sonar/rules responses for this resource). */
export interface OrcaDiscoveryAlert {
  rule_id?: string
  name?: string
  details?: string
  negation?: string
  category?: string
  context_score?: boolean
  orca_score?: number
  rule_json?: Record<string, unknown>
  rule_type?: string
  compliance_frameworks?: ApiComplianceFrameworkRef[]
  [key: string]: unknown
}

export type DiscoveryAlertRollbackEntry = ReconcileEntry<OrcaDiscoveryAlert>
export type DiscoveryAlertRollbackData = ReconcileData<OrcaDiscoveryAlert>

/** Coerce a canvas value to a finite score, clamped to [MIN_SCORE, MAX_SCORE]. Decimals allowed. */
export function normalizeScore(value: unknown, fallback = 5): number {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim())
  if (!Number.isFinite(n)) return fallback
  return Math.min(MAX_SCORE, Math.max(MIN_SCORE, n))
}

/**
 * Split a "/"-joined section path into the three fields the Orca API expects
 * (category, sub_category, sub_sub_category). Mirrors
 * api_client/compliance_section.go's SplitComplianceSection: anything past the
 * third level is folded into sub_sub_category so joining reproduces the input.
 */
export function splitComplianceSection(section: string): { category: string; subCategory: string; subSubCategory: string } {
  const parts = section.split('/')
  return {
    category: parts[0] ?? '',
    subCategory: parts[1] ?? '',
    subSubCategory: parts.slice(2).join('/'),
  }
}

/** Rebuild the "/"-joined section path from the API's separate category fields. */
export function joinComplianceSection(category: string, subCategory: string, subSubCategory: string): string {
  return [category, subCategory, subSubCategory].filter((p) => p).join('/')
}

/** Map the UI-friendly compliance framework refs to the API wire shape. */
export function toApiComplianceFrameworks(refs: ComplianceFrameworkRef[]): ApiComplianceFrameworkRef[] {
  return refs.map((ref) => {
    const { category, subCategory, subSubCategory } = splitComplianceSection(ref.section)
    const out: ApiComplianceFrameworkRef = {
      compliance_framework: ref.name,
      category,
      priority: ref.priority,
    }
    if (subCategory) out.sub_category = subCategory
    if (subSubCategory) out.sub_sub_category = subSubCategory
    return out
  })
}

/** Map the API wire shape of compliance framework refs back to the UI-friendly shape (for drift). */
export function fromApiComplianceFrameworks(refs: ApiComplianceFrameworkRef[] | undefined): ComplianceFrameworkRef[] {
  if (!Array.isArray(refs)) return []
  return refs.map((ref) => ({
    name: ref.compliance_framework ?? '',
    section: joinComplianceSection(ref.category ?? '', ref.sub_category ?? '', ref.sub_sub_category ?? ''),
    priority: ref.priority ?? '',
  }))
}

/** Build the Orca discovery-alert body from canvas fields plus the pre-parsed rule/frameworks JSON. */
export function buildDiscoveryAlertBody(
  fields: Record<string, unknown>,
  ruleJson: Record<string, unknown>,
  complianceFrameworks: ComplianceFrameworkRef[],
): OrcaDiscoveryAlert {
  const body: OrcaDiscoveryAlert = {
    name: String(fields.name ?? '').trim(),
    details: String(fields.description ?? '').trim(),
    // Always sent (no omitempty on the Go struct field) — see file header.
    negation: '',
    category: String(fields.category ?? '').trim(),
    context_score: normalizeBool(fields.contextScore, true),
    orca_score: normalizeScore(fields.orcaScore),
    rule_json: ruleJson,
  }
  if (complianceFrameworks.length > 0) {
    body.compliance_frameworks = toApiComplianceFrameworks(complianceFrameworks)
  }
  return body
}

/** Unwrap a `{ data: {...} }` envelope, returning null when absent. */
export function alertFromEnvelope(payload: unknown): OrcaDiscoveryAlert | null {
  if (!payload || typeof payload !== 'object') return null
  const data = (payload as { data?: OrcaDiscoveryAlert }).data
  return data && typeof data === 'object' ? data : null
}
