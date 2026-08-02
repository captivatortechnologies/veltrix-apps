// Shared helpers for the authentik Flows config type (deploy + rollback +
// drift). Shapes follow the authentik `Flow` / `FlowRequest` /
// `PatchedFlowRequest` schemas — see lib/authentikApi.ts for citations. The
// `slug` is this config type's stable identity — it is also the {slug} path
// segment for GET/PUT/PATCH/DELETE .../flows/instances/{slug}/, exactly like
// the Applications config type (a true retrieve-by-identity endpoint, unlike
// OAuth2/OpenID Providers or Groups).

/** `Flow.designation` — the `FlowDesignationEnum` values. */
export const FLOW_DESIGNATIONS = new Set([
  'authentication',
  'authorization',
  'invalidation',
  'enrollment',
  'unenrollment',
  'recovery',
  'stage_configuration',
])

/** `Flow.authentication` — the `AuthenticationEnum` values (optional; authentik applies its own default when omitted). */
export const AUTHENTICATION_REQUIREMENTS = new Set([
  'none',
  'require_authenticated',
  'require_unauthenticated',
  'require_superuser',
  'require_redirect',
  'require_outpost',
  'require_token',
])

/** authentik's slug pattern for `Flow.slug` (from the OpenAPI schema). */
export const SLUG_PATTERN = /^[-a-zA-Z0-9_]+$/

/** An authentik Flow as returned by the Flows API (fields this config type reads). */
export interface AuthentikFlow {
  pk?: string
  name?: string
  slug?: string
  title?: string
  designation?: string
  authentication?: string
  [key: string]: unknown
}

/** The subset of Flow fields this config type authors. */
export interface ManagedFlowFields {
  name: string
  title: string
  designation: string
  authentication: string
}

/** Read the managed fields out of one canvas item's flat `fields` record. */
export function readManagedFields(fields: Record<string, unknown>): ManagedFlowFields {
  return {
    name: String(fields.name ?? '').trim(),
    title: String(fields.title ?? '').trim(),
    designation: String(fields.designation ?? '').trim(),
    authentication: String(fields.authentication ?? '').trim(),
  }
}

/**
 * The managed-field projection shared by create and update. `authentication`
 * is only included when declared, so a PATCH leaves authentik's own default
 * (or a value another admin set) untouched rather than clearing it.
 */
function buildManagedBody(managed: ManagedFlowFields): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: managed.name,
    title: managed.title,
    designation: managed.designation,
  }
  if (managed.authentication) body.authentication = managed.authentication
  return body
}

/** Build the POST body (`FlowRequest`) — includes the immutable `slug`. */
export function buildCreateBody(slug: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { slug, ...buildManagedBody(readManagedFields(fields)) }
}

/** Build the PATCH body (`PatchedFlowRequest`) — managed fields only; `slug` is never sent. */
export function buildPatchBody(fields: Record<string, unknown>): Record<string, unknown> {
  return buildManagedBody(readManagedFields(fields))
}

/** Build a PATCH body directly from a captured `ManagedFlowFields` snapshot (rollback restore). */
export function managedFieldsToPatchBody(managed: ManagedFlowFields): Record<string, unknown> {
  return buildManagedBody(managed)
}

/** Snapshot the managed fields off a LIVE flow, for rollback restore / drift comparison. */
export function snapshotManagedFields(flow: AuthentikFlow): ManagedFlowFields {
  return {
    name: String(flow.name ?? '').trim(),
    title: String(flow.title ?? '').trim(),
    designation: String(flow.designation ?? '').trim(),
    authentication: String(flow.authentication ?? '').trim(),
  }
}

/**
 * True when the two managed-field snapshots are equal. `authentication` is
 * only compared when OUR declared spec set a value — left blank means we
 * deliberately don't manage it (see buildManagedBody), so a live value there
 * is not drift.
 */
export function sameManagedFields(expected: ManagedFlowFields, actual: ManagedFlowFields): boolean {
  if (expected.name !== actual.name) return false
  if (expected.title !== actual.title) return false
  if (expected.designation !== actual.designation) return false
  if (expected.authentication && expected.authentication !== actual.authentication) return false
  return true
}
