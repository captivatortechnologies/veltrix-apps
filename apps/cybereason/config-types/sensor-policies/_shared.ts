// Shared helpers for the Cybereason Sensor Policies config type
// (validate + deploy + rollback + drift + tests).
//
// A sensor policy is Cybereason's prevention/detection configuration assigned to
// sensors or sensor groups (anti-malware, anti-exploit, anti-ransomware,
// application control, PowerShell protection, the behavioral rules engine, VPP,
// device collection, ...). The authoring identity is the policy NAME
// (configuration.nameDescription.name / metadata.name); Cybereason assigns the
// GUID `id`.
//
// CONFIRMED — list/get/create/delete — cross-referenced against:
//   (a) forensic-security/cybereason (async Python SDK) sensors.py POLICIES
//       region: GET /rest/policies (list, optional filter), GET
//       /rest/policies/{id} (full { metadata, configuration }), POST
//       /rest/policies (create — body is the flat `configuration` shape, keyed
//       by `nameDescription.name`), DELETE /rest/policies/{id}?assignToPolicyId=
//       (reassigns sensors to another policy — mirrors the Groups delete shape).
//   (b) tests/schemas/sensors.yaml in that SAME repo, whose `policies` JSON
//       Schema is checked in a live-tenant integration test
//       (test_get_policies → client.get_policies(show_config=True)) — i.e. the
//       field names/enums below are drawn from a REAL recorded tenant response,
//       not guessed from documentation.
//
// FLAGGED / UNVERIFIED — updating an EXISTING policy (PUT /rest/policies/{id}):
// neither the Python SDK above nor the actively-maintained Cortex XSOAR
// Cybereason integration (github.com/demisto/content) implement a policy update
// call (the XSOAR integration has no policy commands at all), and Cybereason's
// own API docs require a customer login (nest.cybereason.com / api-doc.cybereason.com
// both 401/redirect-to-login for an unauthenticated fetch). PUT is inferred
// ONLY by symmetry with the Groups resource on the SAME tenant, which shares an
// identical list/create/get-by-id/delete-with-reassignment shape and DOES have a
// confirmed PUT /rest/groups/{id}. deploy.ts attempts PUT for an existing policy
// and surfaces a clear, specific failure (not a silent no-op) if a tenant
// rejects it — VERIFY against a live Cybereason tenant before relying on this in
// production.
export const POLICY_ENDPOINTS = {
  /** CONFIRMED — list all policies (lightweight rows: at least `id` + `name`). */
  list: '/rest/policies',
  /** CONFIRMED — full policy detail: `{ metadata, configuration }`. */
  get: (id: string) => `/rest/policies/${encodeURIComponent(id)}`,
  /** CONFIRMED — create a policy. Body is the flat `configuration` shape. */
  create: '/rest/policies',
  /** UNVERIFIED — inferred by symmetry with `PUT /rest/groups/{id}`. */
  update: (id: string) => `/rest/policies/${encodeURIComponent(id)}`,
  /** CONFIRMED — delete a policy, reassigning its sensors to `assignToPolicyId`. */
  remove: (id: string, assignToPolicyId: string) =>
    `/rest/policies/${encodeURIComponent(id)}?assignToPolicyId=${encodeURIComponent(assignToPolicyId)}`,
} as const

/** A lightweight row from the policies LIST endpoint. */
export interface PolicyListRow {
  id?: string
  name?: string
  [key: string]: unknown
}

/** The full `{ metadata, configuration }` envelope from GET /rest/policies/{id}. */
export interface PolicyDetail {
  metadata?: {
    id?: string
    name?: string
    isDefault?: boolean
    [key: string]: unknown
  }
  configuration?: Record<string, unknown>
}

/** Trim + lowercase a policy name so two that differ only in case still match. */
export function normalizeName(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

/** Parse the /rest/policies list response. Tolerates a bare array or a `{ policies }` envelope. */
export function policiesFromResponse(body: string): PolicyListRow[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return []
  }
  if (Array.isArray(parsed)) return parsed as PolicyListRow[]
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>
    const inner = obj.policies ?? obj.data ?? obj.items
    if (Array.isArray(inner)) return inner as PolicyListRow[]
  }
  return []
}

/** Parse a GET /rest/policies/{id} detail response into `{ metadata, configuration }`. */
export function policyDetailFromResponse(body: string): PolicyDetail | null {
  try {
    const parsed = JSON.parse(body) as PolicyDetail
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** Find a policy by its (normalized) name in a LIST response. */
export function findPolicyByName(rows: PolicyListRow[], name: string): PolicyListRow | null {
  const target = normalizeName(name)
  if (!target) return null
  return rows.find((r) => normalizeName(r.name) === target) ?? null
}

/** Parse the canvas-authored `configuration` JSON blob. Returns `{}` for a blank value. */
export function parseConfigurationBlob(value: unknown): Record<string, unknown> {
  const raw = String(value ?? '').trim()
  if (!raw) return {}
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The policy configuration must be a JSON object.')
  }
  return parsed as Record<string, unknown>
}

/** True when a string is blank or parses as a JSON object (not array/primitive). */
export function isValidJsonObject(value: unknown): boolean {
  const raw = String(value ?? '').trim()
  if (!raw) return true
  try {
    const parsed = JSON.parse(raw)
    return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed)
  } catch {
    return false
  }
}

/** Canvas fields authored for one sensor policy. */
export interface PolicyFields {
  name?: unknown
  description?: unknown
  notes?: unknown
  configuration?: unknown
}

/**
 * Build the flat policy body sent to POST /rest/policies (create) or PUT
 * /rest/policies/{id} (update). The typed `name` / `description` / `notes`
 * fields always win over anything of the same key already present in the
 * authored `configuration.nameDescription` blob — mirroring how Cisco Meraki's
 * Appliance VLANs merges its typed fields over its `advanced` JSON blob.
 */
export function buildPolicyBody(fields: PolicyFields): Record<string, unknown> {
  const parsed = parseConfigurationBlob(fields.configuration)
  const priorNameDescription =
    parsed.nameDescription && typeof parsed.nameDescription === 'object' && !Array.isArray(parsed.nameDescription)
      ? (parsed.nameDescription as Record<string, unknown>)
      : {}

  const name = String(fields.name ?? '').trim()
  const description = String(fields.description ?? '').trim()
  const notes = String(fields.notes ?? '').trim()

  return {
    ...parsed,
    nameDescription: {
      ...priorNameDescription,
      name,
      ...(description ? { description } : {}),
      ...(notes ? { notes } : {}),
    },
  }
}

/** Known enum values drawn from the live-tenant-recorded `policies` schema. Not exhaustive by design. */
const KNOWN_ENUMS: Array<{ path: string[]; values: Set<string | number> }> = [
  { path: ['antiMalware', 'detectMode'], values: new Set([1, 2, 3, 4]) },
  { path: ['antiMalware', 'preventMode'], values: new Set([1, 2, 3, 4]) },
  { path: ['antiMalware', 'signatureMode'], values: new Set(['BLOCK', 'DETECT', 'DISABLED', 'QUARANTINE']) },
  { path: ['antiMalware', 'documentProtectionMode'], values: new Set(['DETECT', 'DISABLED', 'PREVENT', 'QUARANTINE']) },
  { path: ['antiMalware', 'variantFilePreventionMode'], values: new Set(['VFP_MODE_DETECT', 'VFP_MODE_DISABLED', 'VFP_MODE_PREVENT', 'VFP_MODE_QUARANTINE']) },
  { path: ['antiExploit', 'antiExploitMode'], values: new Set(['AGGRESSIVE', 'CAUTIOUS', 'EXISTING']) },
  { path: ['arw', 'mode'], values: new Set(['DETECT', 'DISABLED', 'PREVENT']) },
  { path: ['arw', 'level'], values: new Set(['AGGRESSIVE', 'CAUTIOUS', 'MODERATE']) },
  { path: ['rulesEngine', 'bsaMode'], values: new Set(['DETECT', 'DISABLED', 'PREVENT']) },
  { path: ['rulesEngine', 'rulesEngineMode'], values: new Set(['DETECT', 'DISABLED', 'PREVENT']) },
]

function getPath(obj: Record<string, unknown>, path: string[]): unknown {
  let cur: unknown = obj
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

/**
 * Check the small set of well-known, live-tenant-confirmed enum fields inside a
 * parsed policy configuration. Mirrors Cisco Meraki's singleton-settings
 * approach: only the well-documented enums are checked; the rest of this large,
 * deeply-nested schema passes through as declared and Cybereason validates it at
 * deploy time.
 */
export function checkKnownEnums(config: Record<string, unknown>): Array<{ path: string; value: unknown; allowed: string }> {
  const problems: Array<{ path: string; value: unknown; allowed: string }> = []
  for (const { path, values } of KNOWN_ENUMS) {
    const value = getPath(config, path)
    if (value === undefined) continue
    if (!values.has(value as string | number)) {
      problems.push({ path: path.join('.'), value, allowed: [...values].join(', ') })
    }
  }
  return problems
}

/**
 * Recursively diff every key actually DECLARED in `declared` against the same
 * path in `live` — not a whitelist of fields, so any authored key is checked at
 * any nesting depth (same technique as Cisco Meraki's singleton `projectDeclared`).
 * Arrays are compared by JSON equality (order-sensitive); objects recurse.
 */
export function diffDeclaredKeys(
  declared: Record<string, unknown>,
  live: Record<string, unknown> | null | undefined,
  pathPrefix = '',
): Array<{ path: string; expected: unknown; actual: unknown }> {
  const diffs: Array<{ path: string; expected: unknown; actual: unknown }> = []
  const liveObj = live && typeof live === 'object' ? live : {}

  for (const [key, expected] of Object.entries(declared)) {
    const path = pathPrefix ? `${pathPrefix}.${key}` : key
    const actual = (liveObj as Record<string, unknown>)[key]

    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      diffs.push(
        ...diffDeclaredKeys(
          expected as Record<string, unknown>,
          actual && typeof actual === 'object' && !Array.isArray(actual) ? (actual as Record<string, unknown>) : {},
          path,
        ),
      )
      continue
    }

    const expectedJson = JSON.stringify(expected ?? null)
    const actualJson = JSON.stringify(actual ?? null)
    if (expectedJson !== actualJson) {
      diffs.push({ path, expected, actual })
    }
  }
  return diffs
}
