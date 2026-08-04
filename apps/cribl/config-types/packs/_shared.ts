// Cribl Packs config type — installs/upgrades Packs from a git or registry
// SOURCE (not a local .crbl file upload — see README "Intentionally excluded")
// over /api/v1/m/<group>/packs. Cribl's own Pack lifecycle is asymmetric
// between install and upgrade, so this config type is hand-written rather than
// built on the shared record engine:
//   list    : GET   /api/v1/m/<group>/packs                                          → PackInstallInfo[]
//   install : POST  /api/v1/m/<group>/packs           { id, source, spec, ... }       (JSON body)
//   upgrade : PATCH /api/v1/m/<group>/packs/<id>?source=..&spec=..&disabled=..        (QUERY PARAMS, no body)
//   remove  : DELETE/api/v1/m/<group>/packs/<id>
//
// `spec` is a branch/tag/semver constraint (e.g. "^1.3.0"); the live object's
// `version` is the constraint's currently-resolved version. Rollback pins the
// exact prior `version` (not the original loose `spec`) so a downgrade is
// reproducible rather than re-resolving to whatever the constraint means today.
//
// NOTE: field names + endpoints follow the documented PackRequestBody /
// PackInstallInfo schemas. Verify against a live Cribl.

import { buildCriblUrl, criblConnect, getJson, sendJson, groupResourcePath } from '../../lib/criblApi'
import { itemsFromList, resolveWorkerGroup, findById } from '../../lib/criblCommon'

export const PACKS_RESOURCE = 'packs'

/** One installed Pack as returned by GET /api/v1/m/<group>/packs. */
export interface PackInstallInfo {
  id?: string
  source?: string
  spec?: string
  version?: string
  description?: string
  displayName?: string
  author?: string
  disabled?: boolean
  [key: string]: unknown
}

export interface PackSpec {
  id: string
  body: Record<string, unknown> | null
  error: string | null
}

/** Cribl Pack ids: letters, digits, underscore and hyphen (no spaces). */
export const PACK_ID_RE = /^[A-Za-z0-9_-]+$/

export function buildPackSpec(fields: Record<string, unknown>): PackSpec {
  const id = String(fields.id ?? '').trim()
  if (!id) return { id: '', body: null, error: null }
  if (!PACK_ID_RE.test(id)) {
    return { id, body: null, error: `Pack ID "${id}" may contain only letters, digits, underscore and hyphen.` }
  }
  const source = String(fields.source ?? '').trim()
  if (!source) return { id, body: null, error: 'source is required — a git URL or Pack registry reference to install from.' }

  const body: Record<string, unknown> = { id, source, disabled: Boolean(fields.disabled) }
  const spec = String(fields.spec ?? '').trim()
  if (spec) body.spec = spec
  const displayName = String(fields.display_name ?? '').trim()
  if (displayName) body.displayName = displayName
  const description = String(fields.description ?? '').trim()
  if (description) body.description = description
  const author = String(fields.author ?? '').trim()
  if (author) body.author = author
  if (fields.allow_custom_functions !== undefined) body.allowCustomFunctions = Boolean(fields.allow_custom_functions)

  return { id, body, error: null }
}

export function groupOf(fields: Record<string, unknown>, settings: Record<string, unknown>): string {
  return resolveWorkerGroup(fields, settings)
}

export async function listPacks(base: string, headers: Record<string, string>, group: string): Promise<PackInstallInfo[]> {
  try {
    return itemsFromList<PackInstallInfo>(await getJson<unknown>(groupResourcePath(base, group, PACKS_RESOURCE), headers))
  } catch {
    return []
  }
}

export function findPack(packs: PackInstallInfo[], id: string): PackInstallInfo | null {
  return findById(packs, id)
}

/** PATCH .../packs/<id> takes its "Upgrade Pack" params on the query string, not a JSON body. */
export function upgradeQuery(params: { source?: string; spec?: string; minor?: boolean; disabled?: boolean }): string {
  const qs = new URLSearchParams()
  if (params.source) qs.set('source', params.source)
  if (params.spec) qs.set('spec', params.spec)
  if (params.minor !== undefined) qs.set('minor', String(params.minor))
  if (params.disabled !== undefined) qs.set('disabled', String(params.disabled))
  const s = qs.toString()
  return s ? `?${s}` : ''
}

/** Resolve the target base URL + credential headers the same way every Cribl handler does. */
export async function connectFor(ctx: {
  component: Parameters<typeof buildCriblUrl>[0]
  connectivity: Parameters<typeof buildCriblUrl>[1]
  connectivityProvider: Parameters<typeof buildCriblUrl>[2]
  settings?: Record<string, unknown>
  credential: Parameters<typeof criblConnect>[1]
}): Promise<{ base: string; headers: Record<string, string> }> {
  const base = buildCriblUrl(ctx.component, ctx.connectivity, ctx.connectivityProvider, Number(ctx.settings?.cribl_api_port) || undefined)
  const headers = await criblConnect(base, ctx.credential)
  return { base, headers }
}

export { sendJson, groupResourcePath }
