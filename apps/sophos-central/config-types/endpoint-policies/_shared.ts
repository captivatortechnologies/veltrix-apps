// =============================================================================
// Shared helpers for the Sophos Central Endpoint Policies config type.
//
// A policy is a PER-OBJECT resource: Sophos assigns it a server-side `id` on
// create, and a tenant can hold many per `type`. This config type reconciles
// by the (name, type) pair — list, match, update (PATCH) or create (POST).
// `type` is immutable after creation.
//
// The nested `appliesTo`/`settings` schema is large, type-specific and
// documented by Sophos as "keys have specific names documented here" rather
// than a fixed shape — so, following Cisco Meraki's Group Policies precedent,
// they are authored as JSON blobs and passed through as declared rather than
// flattened into dozens of type-specific canvas fields.
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import { canonicalJson, coerceBoolean, parseJsonObject, readOptionalNumber, str } from '../../lib/sophosCommon'
import type { SophosPolicy } from '../../lib/sophosApi'

export interface PolicySpec {
  itemName: string
  name: string
  type: string
  enabled: boolean
  priority?: number
  disableAt: string
  appliesToRaw: unknown
  settingsRaw: unknown
}

/** The policy's logical identity: its (name, type) pair, name lower-cased for matching. */
export function policyKey(name: string, type: string): string {
  return `${name.trim().toLowerCase()}::${type.trim()}`
}

export function extractPolicySpecs(canvas: CanvasSnapshot): PolicySpec[] {
  return (canvas.items ?? canvas.sections ?? []).map((item) => {
    const fields = item.fields ?? {}
    return {
      itemName: item.name,
      name: str(fields.name),
      type: str(fields.type),
      enabled: coerceBoolean(fields.enabled, true),
      priority: readOptionalNumber(fields.priority),
      disableAt: str(fields.disableAt),
      appliesToRaw: fields.appliesTo,
      settingsRaw: fields.settings,
    }
  })
}

export interface ParsedPolicySpec {
  name: string
  type: string
  enabled: boolean
  priority?: number
  disableAt: string | null
  appliesTo: Record<string, unknown>
  settings: Record<string, unknown>
}

/** Parse a spec's JSON blobs, returning the parse error (if any) for validate/deploy to surface. */
export function parsePolicySpec(spec: PolicySpec): { value: ParsedPolicySpec | null; error: string | null } {
  const { value: appliesTo, error: appliesToError } = parseJsonObject(spec.appliesToRaw, 'appliesTo')
  if (appliesToError) return { value: null, error: appliesToError }
  const { value: settings, error: settingsError } = parseJsonObject(spec.settingsRaw, 'settings')
  if (settingsError) return { value: null, error: settingsError }

  return {
    value: {
      name: spec.name,
      type: spec.type,
      enabled: spec.enabled,
      priority: spec.priority,
      disableAt: spec.disableAt || null,
      appliesTo: appliesTo ?? {},
      settings: settings ?? {},
    },
    error: null,
  }
}

/** Build the create request body from a parsed spec. */
export function buildPolicyCreateBody(
  parsed: ParsedPolicySpec,
): Pick<SophosPolicy, 'name' | 'type'> & Partial<Omit<SophosPolicy, 'name' | 'type' | 'id'>> {
  const body: Pick<SophosPolicy, 'name' | 'type'> & Partial<Omit<SophosPolicy, 'name' | 'type' | 'id'>> = {
    name: parsed.name,
    type: parsed.type,
    enabled: parsed.enabled,
  }
  if (parsed.priority !== undefined) body.priority = parsed.priority
  if (parsed.disableAt) body.disableAt = parsed.disableAt
  if (Object.keys(parsed.appliesTo).length > 0) body.appliesTo = parsed.appliesTo
  if (Object.keys(parsed.settings).length > 0) body.settings = parsed.settings
  return body
}

/** Build the PATCH body (name/priority/enabled/disableAt/appliesTo/settings — `type` is immutable). */
export function buildPolicyPatchBody(parsed: ParsedPolicySpec): Partial<Omit<SophosPolicy, 'id' | 'type'>> {
  return {
    name: parsed.name,
    enabled: parsed.enabled,
    priority: parsed.priority,
    disableAt: parsed.disableAt,
    appliesTo: parsed.appliesTo,
    settings: parsed.settings,
  }
}

/** The declared fields, scoped for drift/no-op comparison against a live policy. */
export function declaredPolicyProjection(parsed: ParsedPolicySpec): Record<string, unknown> {
  return {
    name: parsed.name,
    enabled: parsed.enabled,
    priority: parsed.priority ?? null,
    disableAt: parsed.disableAt,
    appliesTo: parsed.appliesTo,
    settings: parsed.settings,
  }
}

/** Does the live policy already match every declared field? */
export function policyMatches(parsed: ParsedPolicySpec, live: SophosPolicy): boolean {
  const actual = {
    name: live.name,
    enabled: live.enabled ?? true,
    priority: live.priority ?? null,
    disableAt: live.disableAt ?? null,
    appliesTo: live.appliesTo ?? {},
    settings: live.settings ?? {},
  }
  return canonicalJson(declaredPolicyProjection(parsed)) === canonicalJson(actual)
}
