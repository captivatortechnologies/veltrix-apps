// =============================================================================
// Generic settings-catalog endpoint-security policy — import & manage.
//
// Antivirus / Firewall / EDR / Disk-encryption / Account-protection policies use
// the same Graph beta configurationPolicies endpoint as ASR, but their settings
// schemas are large and opaque (thousands of settingDefinitionId GUIDs Microsoft
// does not publish). Hand-authoring them is impractical, so this config type uses
// the round-trip model recommended by research: an admin exports a policy's JSON
// from the Intune admin center (or a Graph GET with $expand=settings), and the
// canvas version-controls, deploys, drift-detects and rolls it back by name.
//
// The imported JSON already carries its own templateReference, so this app needs
// no hardcoded per-family template GUIDs — it works for every endpoint-security
// family that uses the settings catalog.
// =============================================================================

import { graphErrorMessage, parseJson, type IntuneClient } from './intune'

/** Endpoint-security settings-catalog template families (for validation + labeling). */
export const ENDPOINT_SECURITY_FAMILIES = [
  'endpointSecurityAntivirus',
  'endpointSecurityDiskEncryption',
  'endpointSecurityFirewall',
  'endpointSecurityEndpointDetectionAndResponse',
  'endpointSecurityAttackSurfaceReduction',
  'endpointSecurityAccountProtection',
  'endpointSecurityApplicationControl',
  'endpointSecurityEndpointPrivilegeManagement',
] as const

/** The shape we read out of an imported (or live) configurationPolicy. */
export interface ImportedPolicy {
  name?: string
  description?: string
  platforms?: string
  technologies?: string
  roleScopeTagIds?: string[]
  templateReference?: { templateId?: string; templateFamily?: string }
  settings?: unknown[]
}

/**
 * Parse an imported policy JSON blob. NON-UNION { value, error } (the platform
 * handler loader cannot narrow discriminated unions). Accepts either a full
 * configurationPolicy object or a bare `{ settings: [...] }` fragment.
 */
export function parsePolicyJson(raw: string | undefined): { value: ImportedPolicy | null; error: string | null } {
  const text = (raw ?? '').trim()
  if (!text) return { value: null, error: 'is required — paste the exported policy JSON' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { value: null, error: `must be valid JSON (${err instanceof Error ? err.message : 'parse error'})` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { value: null, error: 'must be a JSON object (a configurationPolicy)' }
  }
  const obj = parsed as Record<string, unknown>
  if (!Array.isArray(obj.settings)) {
    return { value: null, error: 'must contain a "settings" array (export the policy with its settings)' }
  }
  const templateRef = obj.templateReference
  if (!templateRef || typeof templateRef !== 'object') {
    return { value: null, error: 'must contain a "templateReference" (export an endpoint-security policy)' }
  }
  return { value: obj as ImportedPolicy, error: null }
}

/** The template family of an imported/live policy, or '' if absent. */
export function policyFamily(policy: ImportedPolicy): string {
  return policy.templateReference?.templateFamily ?? ''
}

export function isEndpointSecurityFamily(family: string): boolean {
  return (ENDPOINT_SECURITY_FAMILIES as readonly string[]).includes(family)
}

/**
 * Build the POST/PATCH body from an imported policy, forcing `name`/`description`
 * from the canvas (the canvas is the identity source of truth) and defaulting the
 * envelope fields when the import omitted them.
 */
export function buildPolicyBody(name: string, description: string, imported: ImportedPolicy): Record<string, unknown> {
  return {
    name,
    description,
    platforms: imported.platforms ?? 'windows10',
    technologies: imported.technologies ?? 'mdm',
    roleScopeTagIds: Array.isArray(imported.roleScopeTagIds) && imported.roleScopeTagIds.length > 0 ? imported.roleScopeTagIds : ['0'],
    templateReference: imported.templateReference,
    settings: imported.settings ?? [],
  }
}

/** A stable, order-insensitive stringification of a settings tree (for drift). */
export function stableSettingsHash(settings: unknown): string {
  return stableStringify(settings)
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj)
      .filter((k) => !k.startsWith('@odata') && k !== 'settingCount')
      .sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** List all configuration policies (name/id/templateReference); throws on a non-OK response. */
export async function listConfigurationPolicies(client: IntuneClient): Promise<Array<ImportedPolicy & { id?: string }>> {
  const res = await client.getAll<ImportedPolicy & { id?: string }>('/deviceManagement/configurationPolicies')
  if (!res.ok) {
    throw new Error(`Failed to list configuration policies: ${graphErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

/** GET a single policy with its settings expanded. */
export async function getPolicyWithSettings(client: IntuneClient, id: string): Promise<(ImportedPolicy & { id?: string }) | null> {
  const res = await client.request('GET', `/deviceManagement/configurationPolicies/${id}`, { query: { $expand: 'settings' } })
  if (!res.ok) return null
  return parseJson<ImportedPolicy & { id?: string }>(res.body)
}
