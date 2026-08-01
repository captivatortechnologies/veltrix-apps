// Shared shapes + body builders for the Tanium Packages config type.
//
// A Tanium package / package_spec (GET/POST /api/v2/packages, .../by-name/{name},
// .../{id}) is minimally a `name` + a `command` line the Tanium Client runs.
// Confirmed create body from Tanium's public integrations is `{ name, command }`
// (Cortex XSOAR Tanium_v2 `tn-create-package` takes name + command; Splunk SOAR
// taniumrest reads packages by name). The package_spec also carries `display_name`,
// `expire_seconds` and a command timeout (Tanium package_spec schema / Tanium KB
// "Create New Package").
//
// VERIFY AGAINST A LIVE TANIUM (FLAGGED):
//   - `command_timeout_seconds` — some Tanium builds name this field `command_timeout`.
//     Only sent when the operator supplies a value, so a name mismatch affects opt-in
//     use only. Verify the exact field name against your Tanium.
//   - Update = delete + recreate. REST v2 exposes no confirmed in-place update for
//     packages; replacing one churns its object id (saved actions referencing the
//     package by id may need re-pointing).

import type { NamedEntity } from '../../lib/taniumRestEntity'

/** Tanium's REST v2 collection name for this object. */
export const PACKAGES_RESOURCE = 'packages'

/** One package as returned by /api/v2/packages (usually `{ data: {...} }`). */
export interface TaniumPackage extends NamedEntity {
  command?: string
  display_name?: string
  command_timeout_seconds?: number
  /** Older builds surface the timeout as `command_timeout`; read both. */
  command_timeout?: number
  expire_seconds?: number
}

/** The body POST /api/v2/packages accepts for a package. */
export interface TaniumPackageBody {
  name: string
  command: string
  display_name?: string
  command_timeout_seconds?: number
  expire_seconds?: number
}

/** Parse an optional non-negative-integer field (a canvas number or its string). */
export function parseNonNegativeInt(raw: unknown): { value?: number; error?: string } {
  const s = String(raw ?? '').trim()
  if (!s) return { value: undefined }
  if (!/^\d+$/.test(s)) return { error: 'must be a non-negative whole number of seconds' }
  return { value: Number(s) }
}

/** The command timeout carried by a package, tolerating either field name. */
export function packageTimeout(pkg: TaniumPackage | null | undefined): number | undefined {
  return pkg?.command_timeout_seconds ?? pkg?.command_timeout
}

/** Build the package body from canvas fields. Optional fields are sent only when set. */
export function buildPackageBody(fields: Record<string, unknown>): TaniumPackageBody {
  const body: TaniumPackageBody = {
    name: String(fields.name ?? '').trim(),
    command: String(fields.command ?? '').trim(),
  }
  const displayName = String(fields.displayName ?? '').trim()
  if (displayName) body.display_name = displayName

  const timeout = parseNonNegativeInt(fields.commandTimeout)
  if (timeout.value !== undefined) body.command_timeout_seconds = timeout.value

  const expire = parseNonNegativeInt(fields.expireSeconds)
  if (expire.value !== undefined) body.expire_seconds = expire.value

  return body
}

/** Rebuild a POST body from a captured prior package for rollback. */
export function restorePackageBody(prior: TaniumPackage): TaniumPackageBody {
  const body: TaniumPackageBody = {
    name: String(prior.name ?? '').trim(),
    command: String(prior.command ?? '').trim(),
  }
  if (prior.display_name) body.display_name = prior.display_name
  const timeout = packageTimeout(prior)
  if (timeout !== undefined) body.command_timeout_seconds = timeout
  if (prior.expire_seconds !== undefined) body.expire_seconds = prior.expire_seconds
  return body
}
