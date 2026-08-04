// Shared helpers for the Auth0 Actions config type (deploy + rollback + drift).
//
// Actions are GET/POST /api/v2/actions/actions and GET/PATCH/DELETE
// /api/v2/actions/actions/{id}. Unlike every other list endpoint in this app,
// GET /actions/actions returns a WRAPPED page object ({ actions: [...], total,
// page, per_page }), not a raw array — see network.ts for the pagination loop
// this requires. The Management API keys an action on the server-assigned
// `id`, so this config type upserts by action NAME; the PATCH body omits `name`
// (treated as the fixed identity, consistent with every other config type here).
//
// Secrets are WRITE-ONLY: Auth0 returns each as `{ name, updated_at }` — never
// the value. Authored secrets are always sent on create/update (that's the only
// way to set them), but drift compares secret NAMES only, and rollback cannot
// restore secret VALUES (documented limitation, same shape as this app's other
// write-only-secret handling in connections' `options`).
//
// Verified against the official Auth0 Management API v2 (Actions):
//   https://auth0.com/docs/api/management/v2/actions/get-actions
//   https://auth0.com/docs/api/management/v2/actions/post-action
//   https://auth0.com/docs/api/management/v2/actions/patch-action
//   https://auth0.com/docs/api/management/v2/actions/deploy-action
//   https://auth0.com/docs/api/management/v2/actions/patch-bindings

import { readOptionalString, readString } from '../../lib/fields'

/** Runtimes Auth0 currently offers for an action. */
export const ACTION_RUNTIMES = new Set(['node18', 'node22'])

/**
 * Curated set of triggers this config type authors, with the current default
 * version Auth0 documents for each. An operator can override the version per
 * item (`trigger_version`); if Auth0 introduces a newer version for a trigger,
 * update this map (and the canvas select) rather than hard-coding it per item.
 */
export const TRIGGER_DEFAULT_VERSIONS: Record<string, string> = {
  'post-login': 'v3',
  'credentials-exchange': 'v2',
  'pre-user-registration': 'v2',
  'post-user-registration': 'v2',
  'post-change-password': 'v2',
  'send-phone-message': 'v1',
  'password-reset-post-challenge': 'v1',
}

export const TRIGGER_IDS = new Set(Object.keys(TRIGGER_DEFAULT_VERSIONS))

export interface ActionDependency {
  name: string
  version: string
}

/** A secret name as Auth0 returns it (value is never included). */
export interface ActionSecretName {
  name: string
}

/** One action as returned by the Management API (list/get shape). */
export interface Auth0Action {
  id?: string
  name?: string
  code?: string
  runtime?: string
  supported_triggers?: Array<{ id?: string; version?: string }>
  dependencies?: ActionDependency[]
  secrets?: ActionSecretName[]
  deployed_version?: unknown
  [key: string]: unknown
}

/** The create body — `name` is only sent when creating (immutable thereafter). */
export interface ActionCreateBody {
  name: string
  code: string
  runtime?: string
  supported_triggers: Array<{ id: string; version: string }>
  dependencies?: ActionDependency[]
  secrets?: Array<{ name: string; value: string }>
}

/** The update body — `name` omitted (treated as the fixed identity). */
export type ActionUpdateBody = Omit<ActionCreateBody, 'name'>

/** Find a live action by name (case-sensitive, trimmed) — the upsert identity. */
export function findActionByName(list: Auth0Action[], name: string): Auth0Action | null {
  const n = name.trim()
  if (!n) return null
  return list.find((a) => String(a.name ?? '').trim() === n) ?? null
}

/** Parse the dependencies textarea (`<name>@<version>` per line) into pairs. */
export function parseDependencies(value: unknown): ActionDependency[] {
  const lines = typeof value === 'string' ? value.split(/[\r\n]+/) : []
  const out: ActionDependency[] = []
  for (const raw of lines) {
    const parsed = parseDependencyLine(raw)
    if (parsed) out.push(parsed)
  }
  return out
}

/** Parse one dependency line, or null when blank / malformed. */
export function parseDependencyLine(line: string): ActionDependency | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  const at = trimmed.lastIndexOf('@')
  if (at <= 0) return null
  const name = trimmed.slice(0, at).trim()
  const version = trimmed.slice(at + 1).trim()
  if (!name || !version) return null
  return { name, version }
}

/** Parse the secrets textarea (`<name>=<value>` per line) into name/value pairs. */
export function parseSecretsAuthored(value: unknown): Array<{ name: string; value: string }> {
  const lines = typeof value === 'string' ? value.split(/[\r\n]+/) : []
  const out: Array<{ name: string; value: string }> = []
  const seen = new Set<string>()
  for (const raw of lines) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const name = trimmed.slice(0, eq).trim()
    const secretValue = trimmed.slice(eq + 1)
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push({ name, value: secretValue })
  }
  return out
}

/** Just the secret names declared (for drift, which can never see live values). */
export function secretNames(value: unknown): string[] {
  return parseSecretsAuthored(value).map((s) => s.name)
}

function resolveTriggerVersion(fields: Record<string, unknown>): { id: string; version: string } {
  const id = readString(fields.trigger_id)
  const declaredVersion = readOptionalString(fields.trigger_version)
  const version = declaredVersion ?? TRIGGER_DEFAULT_VERSIONS[id] ?? 'v1'
  return { id, version }
}

/** Build the fields common to create + update from canvas fields. */
function commonBody(fields: Record<string, unknown>): ActionUpdateBody {
  const body: ActionUpdateBody = {
    code: readString(fields.code),
    supported_triggers: [resolveTriggerVersion(fields)],
  }
  const runtime = readOptionalString(fields.runtime)
  if (runtime) body.runtime = runtime
  const dependencies = parseDependencies(fields.dependencies)
  if (dependencies.length > 0) body.dependencies = dependencies
  const secrets = parseSecretsAuthored(fields.secrets)
  if (secrets.length > 0) body.secrets = secrets
  return body
}

/** Build the create body from canvas fields (name included). */
export function buildActionCreateBody(fields: Record<string, unknown>): ActionCreateBody {
  return { name: readString(fields.name), ...commonBody(fields) }
}

/** Build the update body from canvas fields (name omitted — treated as the fixed identity). */
export function buildActionUpdateBody(fields: Record<string, unknown>): ActionUpdateBody {
  return commonBody(fields)
}

/** Capture the prior managed state of a live action for rollback (secrets excluded — see file header). */
export function snapshotAction(action: Auth0Action): ActionUpdateBody {
  const body: ActionUpdateBody = {
    code: typeof action.code === 'string' ? action.code : '',
    supported_triggers: (action.supported_triggers ?? [])
      .filter((t): t is { id: string; version: string } => Boolean(t.id && t.version))
      .map((t) => ({ id: t.id, version: t.version })),
  }
  if (typeof action.runtime === 'string' && action.runtime) body.runtime = action.runtime
  if (Array.isArray(action.dependencies) && action.dependencies.length > 0) body.dependencies = action.dependencies
  return body
}

/** Binding entry shape sent on `PATCH /actions/triggers/{id}/bindings`. */
export interface BindingEntry {
  ref: { type: 'action_id'; value: string }
  display_name: string
}

/** Binding entry shape returned by `GET /actions/triggers/{id}/bindings`. */
export interface LiveBinding {
  id?: string
  display_name?: string
  action?: { id?: string; name?: string }
}

/** Project the live bindings list to the shape `PATCH bindings` expects, unchanged. */
export function liveBindingsToEntries(bindings: LiveBinding[]): BindingEntry[] {
  return bindings
    .filter((b): b is LiveBinding & { action: { id: string } } => Boolean(b.action?.id))
    .map((b) => ({ ref: { type: 'action_id', value: b.action.id }, display_name: b.display_name ?? b.action.name ?? '' }))
}

/**
 * Rebuild a trigger's bindings list so this action is bound (present, with the
 * declared display name) at the end if it wasn't already there, or updated in
 * place if it was — every other entry is passed through untouched and in order.
 */
export function withActionBound(current: BindingEntry[], actionId: string, displayName: string): BindingEntry[] {
  const idx = current.findIndex((b) => b.ref.value === actionId)
  const entry: BindingEntry = { ref: { type: 'action_id', value: actionId }, display_name: displayName }
  if (idx === -1) return [...current, entry]
  const next = current.slice()
  next[idx] = entry
  return next
}

/** Rebuild a trigger's bindings list with this action removed (a no-op if it wasn't bound). */
export function withActionUnbound(current: BindingEntry[], actionId: string): BindingEntry[] {
  return current.filter((b) => b.ref.value !== actionId)
}
