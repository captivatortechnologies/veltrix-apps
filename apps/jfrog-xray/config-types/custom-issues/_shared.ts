// =============================================================================
// Shared types + helpers for the JFrog Xray Custom Issues config type.
// Pure and network-free so validate.ts, deploy.ts, driftDetect.ts and the tests
// all read a canvas item and build an Xray custom-issue body the same way.
//
// UNLIKE every other config type in this app, a custom issue's identity is a
// USER-CHOSEN `id` (Xray does not assign one) — so reconciliation here is
// simple create-or-update-by-id, closer to security-policies' name-based
// upsert than to ignore-rules' server-assigned-id problem.
//
// Wire field names/shapes verified against the official Xray REST API
// reference (see config-types/custom-issues/deploy.ts header for citations).
// Two real discrepancies were found between JFrog's Terraform provider docs
// and the literal REST reference example for this object; both are resolved
// in favor of the concrete REST example (the more authoritative source for a
// wire shape) and noted here:
//   - the JSON key is `provider` (terraform's schema doc calls its own HCL
//     attribute `provider_name`, but confirmed maps to the `provider` field)
//   - a source reference is `{ "source_id": "..." }` (terraform's doc shows a
//     richer `{ id, name, url }` shape that was NOT present in the REST
//     example body — only `source_id` is exposed here as a result)
// =============================================================================

import type { CanvasItemSnapshot, CanvasSnapshot } from '@veltrixsecops/app-sdk'
import { parseJsonArray, readString } from '../../lib/fields'

export const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Information'] as const

// --- Xray custom-issue wire shapes ------------------------------------------------

export interface CustomIssueComponent {
  id: string
  vulnerable_versions?: string[]
  fixed_versions?: string[]
}

export interface CustomIssueCve {
  cve?: string
  cvss_v2?: string
  cvss_v3?: string
}

export interface CustomIssueSource {
  source_id?: string
}

/** The create/update-request body — a full replace on PUT (see deploy.ts). */
export interface CustomIssueBody {
  id: string
  package_type: string
  type: string
  provider: string
  severity: string
  summary?: string
  description?: string
  components: CustomIssueComponent[]
  cves?: CustomIssueCve[]
  sources?: CustomIssueSource[]
}

/** The GET response shape — adds Xray-computed, read-only fields. */
export interface XrayCustomIssue extends CustomIssueBody {
  malicious_package?: boolean
  created?: string
  modified?: string
  edited?: string
  modified_time?: number
  issue_kind?: number
  leading_severity?: unknown
}

// --- Canvas spec extraction ----------------------------------------------------

export interface CustomIssueSpec {
  id: string
  provider: string
  type: string
  packageType: string
  severity: string
  summary: string
  description: string
  componentsJson: string
  cvesJson: string
  sourcesJson: string
}

/** Read every canvas item as a `CustomIssueSpec`. Tolerates the `items`/`sections` alias. */
export function extractCustomIssueSpecs(canvas: CanvasSnapshot): CustomIssueSpec[] {
  const items: CanvasItemSnapshot[] = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      id: readString(f.id),
      provider: readString(f.provider),
      type: readString(f.type) || 'Security',
      packageType: readString(f.package_type) || 'generic',
      severity: readString(f.severity) || 'Medium',
      summary: readString(f.summary),
      description: readString(f.description),
      componentsJson: typeof f.components_json === 'string' ? f.components_json : '',
      cvesJson: typeof f.cves_json === 'string' ? f.cves_json : '',
      sourcesJson: typeof f.sources_json === 'string' ? f.sources_json : '',
    }
  })
}

/** Parse `components_json` into a validated component array (empty on malformed/blank input — validate.ts rejects that case). */
export function buildComponents(spec: CustomIssueSpec): CustomIssueComponent[] {
  const parsed = parseJsonArray(spec.componentsJson)
  if (!parsed.ok) return []
  const out: CustomIssueComponent[] = []
  for (const entry of parsed.value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const rec = entry as Record<string, unknown>
    const id = readString(rec.id)
    if (!id) continue
    const component: CustomIssueComponent = { id }
    if (Array.isArray(rec.vulnerable_versions)) component.vulnerable_versions = rec.vulnerable_versions.map(String)
    if (Array.isArray(rec.fixed_versions)) component.fixed_versions = rec.fixed_versions.map(String)
    out.push(component)
  }
  return out
}

/** Parse `cves_json` into a CVE-reference array. */
export function buildCves(spec: CustomIssueSpec): CustomIssueCve[] {
  const parsed = parseJsonArray(spec.cvesJson)
  if (!parsed.ok) return []
  const out: CustomIssueCve[] = []
  for (const entry of parsed.value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const rec = entry as Record<string, unknown>
    const cve: CustomIssueCve = {}
    if (typeof rec.cve === 'string') cve.cve = rec.cve
    if (typeof rec.cvss_v2 === 'string') cve.cvss_v2 = rec.cvss_v2
    if (typeof rec.cvss_v3 === 'string') cve.cvss_v3 = rec.cvss_v3
    out.push(cve)
  }
  return out
}

/** Parse `sources_json` into a source-reference array (`{ source_id }` — see module header). */
export function buildSources(spec: CustomIssueSpec): CustomIssueSource[] {
  const parsed = parseJsonArray(spec.sourcesJson)
  if (!parsed.ok) return []
  const out: CustomIssueSource[] = []
  for (const entry of parsed.value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const rec = entry as Record<string, unknown>
    if (typeof rec.source_id === 'string') out.push({ source_id: rec.source_id })
  }
  return out
}

/** The full create/update body. `id` is always included — Xray's update is a full replace requiring it. */
export function buildCustomIssueBody(spec: CustomIssueSpec): CustomIssueBody {
  const body: CustomIssueBody = {
    id: spec.id,
    package_type: spec.packageType,
    type: spec.type,
    provider: spec.provider,
    severity: spec.severity,
    components: buildComponents(spec),
  }
  if (spec.summary) body.summary = spec.summary
  if (spec.description) body.description = spec.description
  const cves = buildCves(spec)
  if (cves.length > 0) body.cves = cves
  const sources = buildSources(spec)
  if (sources.length > 0) body.sources = sources
  return body
}

/** Strip the Xray-computed read-only fields before replaying a captured body on PUT (rollback restore). */
export function restorableIssueBody(prior: XrayCustomIssue): CustomIssueBody {
  const { malicious_package, created, modified, edited, modified_time, issue_kind, leading_severity, ...rest } = prior
  return rest
}
