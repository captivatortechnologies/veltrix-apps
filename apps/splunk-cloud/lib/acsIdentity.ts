// =============================================================================
// ACS identity transport + search-head-cluster (SHC) targeting.
//
// The Admin Config Service gained NATIVE identity endpoints
// (`/adminconfig/v2/roles`, `/adminconfig/v2/users`) after this app's `roles`/
// `users` config types were first built against the classic REST API
// (lib/splunkRest.ts). This module is the transport layer for that newer ACS
// surface — generic across any ACS-identity object, with the SHC-targeting
// model that surface requires. Per-object payload shapes (Role/User field
// mapping) live next to each config type (see config-types/roles/acsRoles.ts).
//
// -----------------------------------------------------------------------------
// WHY THIS MODULE EXISTS: SEARCH-HEAD TARGETING
// -----------------------------------------------------------------------------
// Splunk's ACS identity documentation states plainly that role/user writes
// "apply only on the search head on which you create them. ACS does not
// replicate users and roles across the search tier" — by default, an
// untargeted request lands on "the first standard search head or search head
// cluster" member ACS happens to route it to.
//
// To reach a DIFFERENT member of a search head cluster, ACS does not expose a
// separate "target" request parameter or header. Instead, the STACK PATH
// SEGMENT itself changes: prefix it with that member's opaque instance id and
// a literal dot —
//
//     https://admin.splunk.com/{stack}/adminconfig/v2/roles              (default member)
//     https://admin.splunk.com/sh-i-0910d0dfdb9ed913a.{stack}/adminconfig/v2/roles  (one specific member)
//
// — and the bearer token must have been minted ON that targeted member (a
// token from the default member does not authenticate a targeted request).
// This is confirmed against Splunk's OWN client, not just prose: the official
// `terraform-provider-scp`'s generated ACS client treats `stack` as a bare
// string interpolated directly into the URL path (`acs/v2/api.gen.go`:
// `fmt.Sprintf("/%s/adminconfig/v2/roles", pathParam0)`), and its
// `TargetStackName` helper (`internal/utils/utils.go`) builds exactly this
// `"<target>.<stack>"` string; the provider's own docs
// (`docs/index.md#targeting-a-search-head`) show the identical pattern via a
// second, aliased `provider "scp" { stack = "sh-i-....<stack>" }` block.
//
// THERE IS NO ACS ENDPOINT TO ENUMERATE A STACK'S SEARCH-HEAD-CLUSTER MEMBERS.
// The full generated ACS OpenAPI client (`acs/v2/api.gen.go`, ~15k lines) was
// searched end to end for this pass: no "member", "instance", "search head" or
// "SHC" field or endpoint exists anywhere in it. `GET /adminconfig/v2/status`
// (the client's `DescribeStack`) returns only stack-wide infrastructure/restart
// status, not a member list. A member's instance id is therefore something the
// customer must already know from their own deployment (Splunk Web instance
// info, or a Support case) — this app cannot discover or validate it against
// ACS, so it is a free-text canvas field, not a live picker (unlike every
// other object-reference field this app CAN back with a live ACS lookup — see
// config-types/lib/splunkOptions.ts).
//
// Sources (see README "Research sources" for full citations):
//   - help.splunk.com "Manage users, roles, and capabilities in Splunk Cloud
//     Platform (ACS)" — the endpoint schemas and the "does not replicate"
//     statement, and the default/targeted URL examples.
//   - github.com/splunk/terraform-provider-scp:
//       docs/index.md#targeting-a-search-head, docs/resources/roles.md and
//       users.md ("Search Head Targeting" section), internal/utils/utils.go
//       (TargetStackName), acs/v2/api.gen.go (Stack is a bare path string).
// =============================================================================

import { acsErrorMessage, acsRequest, parseJson, type AcsRequestOptions } from './acs'

/**
 * A search-head instance id as it appears in Splunk's own ACS examples
 * (`sh-i-0910d0dfdb9ed913a`) and in this app's own stack-name convention
 * (lib/acs.ts `resolveStackName`): lowercase letters, digits and hyphens,
 * starting with a letter or digit. Splunk does not publish a formal grammar
 * for this id beyond its examples — this is a defensive shape check (it must
 * be safe to splice, unescaped, into a URL path segment as `"<target>.<stack>"`),
 * not a claim of an officially documented format.
 */
export const SEARCH_HEAD_TARGET_RE = /^[a-z0-9][a-z0-9-]*$/
export const MAX_SEARCH_HEAD_TARGET_LENGTH = 100

export function isValidSearchHeadTarget(target: string): boolean {
  return SEARCH_HEAD_TARGET_RE.test(target) && target.length <= MAX_SEARCH_HEAD_TARGET_LENGTH
}

/**
 * Every ACS identity write acknowledges the same disclaimer header
 * unconditionally. ACS only REQUIRES `Federated-Search-Manage-Ack: Y` when the
 * write grants/imports the `fsh_manage` capability — but detecting that
 * accurately would mean resolving every imported role's own capabilities
 * (recursively) before every write, just to decide whether to set a header
 * that is otherwise a harmless no-op acknowledgement. This app already sends
 * other ACS acknowledgement headers unconditionally on writes that need them
 * sometimes (`ACS-Legal-Ack` on every app install, `ACS-Licensing-Ack` on
 * every Splunkbase install — see config-types/apps and splunkbase-apps) —
 * this follows the same, simpler, always-correct convention.
 */
export const FEDERATED_SEARCH_MANAGE_ACK_HEADER: Record<string, string> = {
  'Federated-Search-Manage-Ack': 'Y',
}

/**
 * Resolve the list of stack-path targets a deploy/rollback/drift/health-check
 * pass should address for one item. An empty/undefined declaration means
 * "whatever the default, untargeted stack path resolves to" — ACS's own
 * default behavior — represented here as a single `undefined` target so every
 * caller loops the SAME way regardless of whether explicit targets were given.
 */
export function resolveTargets(explicit: string[] | undefined): Array<string | undefined> {
  return explicit && explicit.length > 0 ? explicit : [undefined]
}

/** Build the ACS stack path segment for one target: `"<target>.<baseStack>"`, or the bare stack when untargeted. */
export function targetedStackPath(baseStack: string, target: string | undefined): string {
  return target ? `${target}.${baseStack}` : baseStack
}

/** Derive ACS request options scoped to one search-head target from the base (untargeted) options. */
export function withTarget(
  acs: AcsRequestOptions,
  baseStack: string,
  target: string | undefined,
): AcsRequestOptions {
  return { ...acs, stack: targetedStackPath(baseStack, target) }
}

/** Human-readable label for a target, for deploy/drift/health-check messages. */
export function describeTarget(target: string | undefined): string {
  return target ? `search head "${target}"` : 'the default search head'
}

// --- Generic ACS-identity entity CRUD ---------------------------------------
//
// Thin, object-shape-agnostic helpers over lib/acs.ts's acsRequest, mirroring
// the get/create/update/delete shape lib/splunkRest.ts offers for the classic
// REST API — so a handler's control flow reads the same regardless of which
// transport it is using. Never throws on a missing entity (404 → null);
// throws (with the ACS `{code,message}` body surfaced) on every other
// non-2xx status, exactly like lib/splunkRest.ts's getEntityContent, so a
// connection/auth failure is never mistaken for "does not exist".

/** GET one entity by path. Returns null on 404, throws on any other failure. */
export async function getAcsIdentityEntity<T>(acs: AcsRequestOptions, entityPath: string): Promise<T | null> {
  const res = await acsRequest(acs, 'GET', entityPath)
  if (res.status === 404) return null
  if (res.status !== 200) {
    throw new Error(`ACS ${entityPath} GET failed: ${acsErrorMessage(res)}`)
  }
  return parseJson<T>(res.body)
}

/** POST to a collection path (create). Throws on any non-2xx status. */
export async function createAcsIdentityEntity<T>(
  acs: AcsRequestOptions,
  collectionPath: string,
  body: unknown,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const res = await acsRequest(acs, 'POST', collectionPath, body, extraHeaders)
  if (!res.ok) {
    throw new Error(`ACS ${collectionPath} POST failed: ${acsErrorMessage(res)}`)
  }
  return parseJson<T>(res.body) as T
}

/** PATCH one entity by path (update). Throws on any non-2xx status. */
export async function updateAcsIdentityEntity<T>(
  acs: AcsRequestOptions,
  entityPath: string,
  body: unknown,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const res = await acsRequest(acs, 'PATCH', entityPath, body, extraHeaders)
  if (!res.ok) {
    throw new Error(`ACS ${entityPath} PATCH failed: ${acsErrorMessage(res)}`)
  }
  return parseJson<T>(res.body) as T
}

/** DELETE one entity by path. Throws on any non-2xx status (404 included — callers only delete what they know exists). */
export async function deleteAcsIdentityEntity(acs: AcsRequestOptions, entityPath: string): Promise<void> {
  const res = await acsRequest(acs, 'DELETE', entityPath)
  if (!res.ok) {
    throw new Error(`ACS ${entityPath} DELETE failed: ${acsErrorMessage(res)}`)
  }
}
