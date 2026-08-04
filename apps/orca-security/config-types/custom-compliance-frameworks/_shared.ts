// Shared helpers for the Orca Custom Compliance Frameworks config type (deploy +
// rollback + drift).
//
// Orca custom compliance frameworks follow the /api/compliance/frameworks
// surface (VERIFIED against terraform-provider-orcasecurity
// api_client/custom_compliance_framework.go — this endpoint has no public REST
// doc page):
//   POST   /api/compliance/frameworks         create; returns { data: { id, name, description } }
//   GET    /api/compliance/frameworks/{id}     read;   returns { data: { id, display_name, description, custom, active, is_ready } }
//   PUT    /api/compliance/frameworks/{id}     update; returns { data: { id, name, description } }
//   DELETE /api/compliance/frameworks/{id}     delete
//
// IMPORTANT — sections are WRITE-ONLY: the read response never echoes
// `sections`/`tests` back (confirmed by the provider's own doc note: "Terraform
// cannot detect drift for sections modified outside of Terraform. Terraform
// preserves the last-applied value in state."). This app follows the same
// approach: driftDetect only compares name/description (the two fields the API
// actually returns), and rollback restores from THIS APP'S OWN previously
// recorded body (rollbackData), not a live GET, because a live GET can never
// recover a section's contents.
//
// The read response also renames `name` to `display_name` — a real API
// asymmetry between write and read shapes, not a typo in this file.

import { normalizeStringList, type ReconcileData, type ReconcileEntry } from '../../lib/reconcile'

/** One compliance-framework test (control): an existing Orca rule id plus its label in this framework. */
export interface FrameworkTest {
  rule_id: string
  rule_id_in_framework: string
}

/** One compliance-framework section: a name plus its tests (and optional nested sections). */
export interface FrameworkSection {
  name: string
  tests: FrameworkTest[]
  sections?: FrameworkSection[]
}

/** The body this app POSTs/PUTs — mirrors CustomComplianceFrameworkCreateRequest/UpdateRequest. */
export interface OrcaComplianceFrameworkBody {
  name: string
  description: string
  sections: FrameworkSection[]
  /**
   * Only sent on CREATE (mirrors CustomComplianceFrameworkCreateRequest, which
   * carries it with no `omitempty`; CustomComplianceFrameworkUpdateRequest has
   * no such field). Its purpose is undocumented outside the provider source —
   * treated as an Orca-internal field this app must echo for wire fidelity,
   * not a user setting.
   */
  checkedKeys?: string[]
}

/** The write-response shape: { data: { id, name, description } } — echoes what was sent. */
export interface OrcaComplianceFrameworkWriteResponse {
  id?: string | number
  name?: string
  description?: string
  [key: string]: unknown
}

/** The read-response shape: { data: { id, display_name, description, custom, active, is_ready } }. */
export interface OrcaComplianceFrameworkReadResponse {
  id?: string
  display_name?: string
  description?: string
  custom?: boolean
  active?: boolean
  is_ready?: boolean
  [key: string]: unknown
}

/**
 * rollbackData.previous[].prior stores the FULL BODY this app last declared
 * (name/description/sections) — not a live read, since sections are
 * unreadable. Rollback PUTs this straight back.
 */
export type ComplianceFrameworkRollbackEntry = ReconcileEntry<OrcaComplianceFrameworkBody>
export type ComplianceFrameworkRollbackData = ReconcileData<OrcaComplianceFrameworkBody>

/** Build the framework body from canvas fields plus the pre-parsed sections array. */
export function buildFrameworkBody(
  fields: Record<string, unknown>,
  sections: FrameworkSection[],
  forCreate: boolean,
): OrcaComplianceFrameworkBody {
  const body: OrcaComplianceFrameworkBody = {
    name: String(fields.name ?? '').trim(),
    description: String(fields.description ?? '').trim(),
    sections,
  }
  if (forCreate) body.checkedKeys = normalizeStringList(fields.checkedKeys)
  return body
}

/** Basic structural check: an array of { name, tests: [{ rule_id, rule_id_in_framework }] }. */
export function isValidSectionsShape(value: unknown): value is FrameworkSection[] {
  if (!Array.isArray(value)) return false
  return value.every((section) => {
    if (!section || typeof section !== 'object' || Array.isArray(section)) return false
    const s = section as Record<string, unknown>
    if (typeof s.name !== 'string' || !s.name.trim()) return false
    if (!Array.isArray(s.tests)) return false
    return s.tests.every((t) => {
      if (!t || typeof t !== 'object' || Array.isArray(t)) return false
      const test = t as Record<string, unknown>
      return typeof test.rule_id === 'string' && test.rule_id.trim().length > 0 && typeof test.rule_id_in_framework === 'string'
    })
  })
}
