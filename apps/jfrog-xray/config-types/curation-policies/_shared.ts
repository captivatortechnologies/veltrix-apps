// =============================================================================
// Shared types + helpers for the JFrog Curation Policies config type.
// Pure and network-free so validate.ts, deploy.ts, driftDetect.ts and the tests
// all read a canvas item and build a curation-policy body the same way.
//
// Served by the Xray REST API under /xray/api/v1/curation/policies. UNLIKE
// security/license/operational-risk policies, the write URLs use a
// SERVER-ASSIGNED `policy_id` (a name is NOT the path key) — but the list
// endpoint supports matching by name, so deploy.ts still reconciles by name
// (list → match → capture id → get/put/delete by id), same operator model as
// every other named object in this app.
//
// `waivers`/`label_waivers` are nested repeatable objects with their own
// add/retain(by id)/remove(by omission) update semantics — exposed as JSON
// escape valves rather than typed repeatable fields (see canvas.yaml).
//
// `condition_id` references an existing curation condition by id; this app
// does NOT manage condition templates or custom conditions (a separate,
// deeper Xray object) — see README Coverage.
//
// Verified against the official Xray REST API reference (see
// config-types/curation-policies/deploy.ts header for citations) and
// JFrog's own Terraform provider docs for the waiver/label-waiver shapes:
//   https://github.com/jfrog/terraform-provider-xray/blob/master/docs/resources/curation_policy.md
// =============================================================================

import type { CanvasItemSnapshot, CanvasSnapshot } from '@veltrixsecops/app-sdk'
import { looksLikeEmail, parseJsonArray, readBool, readOptionalString, readString, readStringArray } from '../../lib/fields'

export const SCOPES = ['all_repos', 'specific_repos', 'pkg_types'] as const
export const POLICY_ACTIONS = ['block', 'dry_run'] as const
export const WAIVER_REQUEST_CONFIGS = ['forbidden', 'manual', 'auto_approved'] as const

// --- Curation policy wire shapes -------------------------------------------------

export interface CurationWaiver {
  id?: string
  pkg_type: string
  pkg_name: string
  all_versions?: boolean
  pkg_versions?: string[]
  justification: string
}

export interface CurationLabelWaiver {
  id?: string
  label: string
  justification: string
}

/** The editable fields — sent on create (POST) and update (PUT). PUT must NOT include read-only fields (see deploy.ts). */
export interface CurationPolicyEditable {
  name: string
  condition_id: string
  scope: string
  policy_action: string
  waiver_request_config: string
  enabled?: boolean
  block_from_cache?: boolean
  repo_include?: string[]
  repo_exclude?: string[]
  pkg_types_include?: string[]
  notify_emails?: string[]
  decision_owners?: string[]
  waivers?: CurationWaiver[]
  label_waivers?: CurationLabelWaiver[]
}

/** The GET response shape — adds server-assigned / computed read-only fields. */
export interface XrayCurationPolicy extends CurationPolicyEditable {
  id: string
  created_by?: string
  updated_by?: string
  created_at?: string
  updated_at?: string
  /** The resolved condition object Xray echoes back — read-only, never sent on write. */
  condition?: unknown
}

// --- Canvas spec extraction ----------------------------------------------------

export interface CurationPolicySpec {
  itemLabel: string
  name: string
  conditionId: string
  policyAction: string
  enabled: boolean
  blockFromCache: boolean
  scope: string
  repoInclude: string[]
  repoExclude: string[]
  pkgTypesInclude: string[]
  waiverRequestConfig: string
  decisionOwners: string[]
  notifyEmails: string[]
  waiversJson: string
  labelWaiversJson: string
}

/** Read every canvas item as a `CurationPolicySpec`. Tolerates the `items`/`sections` alias. */
export function extractCurationPolicySpecs(canvas: CanvasSnapshot): CurationPolicySpec[] {
  const items: CanvasItemSnapshot[] = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemLabel: item.name || readString(f.name) || '(unnamed)',
      name: readString(f.name),
      conditionId: readString(f.condition_id),
      policyAction: readString(f.policy_action) || 'dry_run',
      enabled: readBool(f.enabled, true),
      blockFromCache: readBool(f.block_from_cache, false),
      scope: readString(f.scope) || 'all_repos',
      repoInclude: readStringArray(f.repo_include),
      repoExclude: readStringArray(f.repo_exclude),
      pkgTypesInclude: readStringArray(f.pkg_types_include),
      waiverRequestConfig: readString(f.waiver_request_config) || 'forbidden',
      decisionOwners: readStringArray(f.decision_owners),
      notifyEmails: readStringArray(f.notify_emails),
      waiversJson: typeof f.waivers_json === 'string' ? f.waivers_json : '',
      labelWaiversJson: typeof f.label_waivers_json === 'string' ? f.label_waivers_json : '',
    }
  })
}

/** The policy's logical identity: its name (matched via the list endpoint — see deploy.ts). */
export function policyKey(name: string): string {
  return name.trim()
}

/** Find a live policy by name (exact match). */
export function findPolicy(policies: XrayCurationPolicy[], name: string): XrayCurationPolicy | undefined {
  const key = policyKey(name)
  return policies.find((p) => policyKey(p.name ?? '') === key)
}

/** Parse `waivers_json` into a validated waiver array (empty on malformed/blank input — validate.ts rejects that case). */
export function buildWaivers(spec: CurationPolicySpec): CurationWaiver[] {
  const parsed = parseJsonArray(spec.waiversJson)
  if (!parsed.ok) return []
  const out: CurationWaiver[] = []
  for (const entry of parsed.value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const rec = entry as Record<string, unknown>
    const pkgType = readString(rec.pkg_type)
    const pkgName = readString(rec.pkg_name)
    const justification = readString(rec.justification)
    if (!pkgType || !pkgName || !justification) continue
    const waiver: CurationWaiver = { pkg_type: pkgType, pkg_name: pkgName, justification }
    const id = readOptionalString(rec.id)
    if (id) waiver.id = id
    if (typeof rec.all_versions === 'boolean') waiver.all_versions = rec.all_versions
    if (Array.isArray(rec.pkg_versions)) waiver.pkg_versions = rec.pkg_versions.map(String)
    out.push(waiver)
  }
  return out
}

/** Parse `label_waivers_json` into a validated label-waiver array. */
export function buildLabelWaivers(spec: CurationPolicySpec): CurationLabelWaiver[] {
  const parsed = parseJsonArray(spec.labelWaiversJson)
  if (!parsed.ok) return []
  const out: CurationLabelWaiver[] = []
  for (const entry of parsed.value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const rec = entry as Record<string, unknown>
    const label = readString(rec.label)
    const justification = readString(rec.justification)
    if (!label || !justification) continue
    const waiver: CurationLabelWaiver = { label, justification }
    const id = readOptionalString(rec.id)
    if (id) waiver.id = id
    out.push(waiver)
  }
  return out
}

/** The editable-fields body sent on POST (create) and PUT (update — Xray rejects read-only fields on PUT). */
export function buildEditablePolicy(spec: CurationPolicySpec): CurationPolicyEditable {
  const body: CurationPolicyEditable = {
    name: spec.name,
    condition_id: spec.conditionId,
    scope: spec.scope,
    policy_action: spec.policyAction,
    waiver_request_config: spec.waiverRequestConfig,
    enabled: spec.enabled,
    block_from_cache: spec.blockFromCache,
  }
  if (spec.scope === 'specific_repos' && spec.repoInclude.length > 0) body.repo_include = spec.repoInclude
  if (spec.scope === 'all_repos' && spec.repoExclude.length > 0) body.repo_exclude = spec.repoExclude
  if (spec.scope === 'pkg_types' && spec.pkgTypesInclude.length > 0) body.pkg_types_include = spec.pkgTypesInclude
  if (spec.notifyEmails.length > 0) body.notify_emails = spec.notifyEmails
  if (spec.waiverRequestConfig === 'manual' && spec.decisionOwners.length > 0) body.decision_owners = spec.decisionOwners
  const waivers = buildWaivers(spec)
  if (waivers.length > 0) body.waivers = waivers
  const labelWaivers = buildLabelWaivers(spec)
  if (labelWaivers.length > 0) body.label_waivers = labelWaivers
  return body
}

/** Strip the read-only fields Xray populates on GET before replaying a body on PUT (rollback restore). */
export function restorablePolicy(prior: XrayCurationPolicy): CurationPolicyEditable {
  const { id, created_by, updated_by, created_at, updated_at, condition, ...rest } = prior
  return rest
}

/** Every notify-email/decision-owner entry that doesn't look like an email — for validate.ts. */
export function invalidEmails(values: string[]): string[] {
  return values.filter((v) => !looksLikeEmail(v))
}
