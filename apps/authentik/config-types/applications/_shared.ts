// Shared helpers for the authentik Applications config type (deploy + rollback +
// drift). Shapes follow the authentik Core API `Application` / `ApplicationRequest`
// / `PatchedApplicationRequest` schemas — see lib/authentikApi.ts for citations.
// The `slug` is this config type's stable identity — it is also the {slug} path
// segment for GET/PUT/PATCH/DELETE .../core/applications/{slug}/, so it is never
// part of the managed-field set below (immutable through this config type).

/** `Application.policy_engine_mode` — the `PolicyEngineMode` enum. */
export const POLICY_ENGINE_MODES = new Set(['any', 'all'])
export const DEFAULT_POLICY_ENGINE_MODE = 'any'

/** authentik's slug pattern for `Application.slug` (from the OpenAPI schema). */
export const SLUG_PATTERN = /^[-a-zA-Z0-9_]+$/

/** An authentik Application as returned by the Core API (fields this config type reads). */
export interface AuthentikApplication {
  pk?: string
  name?: string
  slug?: string
  provider?: number | null
  meta_description?: string
  meta_publisher?: string
  policy_engine_mode?: string
  group?: string
  [key: string]: unknown
}

/** The subset of Application fields this config type authors. */
export interface ManagedApplicationFields {
  name: string
  provider: number | null
  meta_description: string
  meta_publisher: string
  group: string
  policy_engine_mode: string
}

/** Read an optional integer field (the referenced provider's pk), tolerating numeric strings. */
export function readOptionalInt(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  return Number.isFinite(n) ? Math.trunc(n) : null
}

/** Read the managed fields out of one canvas item's flat `fields` record. */
export function readManagedFields(fields: Record<string, unknown>): ManagedApplicationFields {
  const policyMode = String(fields.policy_engine_mode ?? '').trim()
  return {
    name: String(fields.name ?? '').trim(),
    provider: readOptionalInt(fields.provider),
    meta_description: String(fields.meta_description ?? '').trim(),
    meta_publisher: String(fields.meta_publisher ?? '').trim(),
    group: String(fields.group ?? '').trim(),
    policy_engine_mode: POLICY_ENGINE_MODES.has(policyMode) ? policyMode : DEFAULT_POLICY_ENGINE_MODE,
  }
}

/** The managed-field projection shared by both the create and update request bodies. */
function buildManagedBody(managed: ManagedApplicationFields): Record<string, unknown> {
  return {
    name: managed.name,
    provider: managed.provider,
    meta_description: managed.meta_description,
    meta_publisher: managed.meta_publisher,
    group: managed.group,
    policy_engine_mode: managed.policy_engine_mode,
  }
}

/** Build the POST body (`ApplicationRequest`) — includes the immutable `slug`. */
export function buildCreateBody(slug: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { slug, ...buildManagedBody(readManagedFields(fields)) }
}

/** Build the PATCH body (`PatchedApplicationRequest`) — managed fields only; `slug` is never sent. */
export function buildPatchBody(fields: Record<string, unknown>): Record<string, unknown> {
  return buildManagedBody(readManagedFields(fields))
}

/** Build a PATCH body directly from a captured `ManagedApplicationFields` snapshot (rollback restore). */
export function managedFieldsToPatchBody(managed: ManagedApplicationFields): Record<string, unknown> {
  return buildManagedBody(managed)
}

/** Snapshot the managed fields off a LIVE application, for rollback restore / drift comparison. */
export function snapshotManagedFields(app: AuthentikApplication): ManagedApplicationFields {
  const policyMode = String(app.policy_engine_mode ?? '').trim()
  return {
    name: String(app.name ?? '').trim(),
    provider: typeof app.provider === 'number' ? app.provider : null,
    meta_description: String(app.meta_description ?? '').trim(),
    meta_publisher: String(app.meta_publisher ?? '').trim(),
    group: String(app.group ?? '').trim(),
    policy_engine_mode: POLICY_ENGINE_MODES.has(policyMode) ? policyMode : DEFAULT_POLICY_ENGINE_MODE,
  }
}

/** True when the two managed-field snapshots are equal — used by drift detection. */
export function sameManagedFields(a: ManagedApplicationFields, b: ManagedApplicationFields): boolean {
  return (
    a.name === b.name &&
    a.provider === b.provider &&
    a.meta_description === b.meta_description &&
    a.meta_publisher === b.meta_publisher &&
    a.group === b.group &&
    a.policy_engine_mode === b.policy_engine_mode
  )
}
