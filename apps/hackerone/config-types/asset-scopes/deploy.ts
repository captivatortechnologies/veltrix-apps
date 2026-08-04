import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildHackeroneClient, hackeroneWriteError, type HackerOneClient } from '../../lib/hackeroneApi'
import {
  buildAssetScopeAttributes,
  buildNotifyFlag,
  createAssetScopeBody,
  updateAssetScopeBody,
  groupItemsByOrganization,
  findOrganizationId,
  findProgramId,
  pickAssetByIdentifier,
  scopesByIdentifier,
  normalizeIdentifier,
  str,
  type AssetScopeAttributes,
  type LiveScope,
} from './_shared'

/**
 * Deploy HackerOne Asset Scopes over the HackerOne API (v1) — attaching an
 * organization Asset (see the Assets config type) to a program's scope. The
 * confirmed, non-deprecated successor to the program-level structured-scope
 * CREATE/UPDATE endpoints (removed from HackerOne's docs 2026-04-07).
 *
 *   resolve organization: GET  /me/organizations                                       → handle → id
 *   resolve program:      GET  /me/programs                                            → handle → id
 *   resolve asset:        GET  /organizations/{orgId}/assets?filter[identifier]=...   → identifier → asset id
 *   read (upsert):        GET  /programs/{programId}/structured_scopes               → existing scopes by asset identifier
 *   create:                POST /organizations/{orgId}/assets/{assetId}/scopes         (+ relationships.programs)
 *   update:                PUT  /organizations/{orgId}/assets/{assetId}/scopes/{id}
 *
 * Items are grouped by organization_handle (the write path's outer segment);
 * within each group, each item independently resolves its own program and asset.
 * rollbackData records, per attachment, whether it already existed, its scope id,
 * the resolved asset/program ids, and the prior attributes — so rollback can
 * restore the prior state or archive what we created.
 *
 * FLAGGED — these endpoints do not state a "Required permissions" scope in
 * HackerOne's published docs; and the create/update bodies use DIFFERENT keys
 * for the same "notify subscribers" boolean (see ./_shared). Verify both against
 * a live token/program before relying on this in production.
 *   Confirmed: https://api.hackerone.com/customer-resources/ (Assets)
 */
interface RollbackEntry {
  organizationHandle: string
  organizationId: string | null
  programHandle: string
  programId: string | null
  assetIdentifier: string
  assetId: string | null
  scopeId: string | null
  existed: boolean
  previousAttributes: Partial<AssetScopeAttributes> | null
}

/** Look up a single organization asset by exact identifier (best-effort). */
async function findAsset(client: HackerOneClient, organizationId: string, identifier: string) {
  try {
    const res = await client.getAll<Record<string, unknown>>(`/organizations/${encodeURIComponent(organizationId)}/assets`, {
      'filter[identifier]': identifier,
    })
    return res.ok ? res.items : []
  } catch {
    return []
  }
}

/** Read every live structured scope for a program (best-effort) — the still-documented GET. */
async function listScopes(client: HackerOneClient, programId: string): Promise<LiveScope[]> {
  try {
    const res = await client.getAll<{ asset_identifier?: string }>(`/programs/${encodeURIComponent(programId)}/structured_scopes`)
    return res.ok ? res.items : []
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for asset-scope deployment' }
  }

  const built = buildHackeroneClient(credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const orgsRes = await client.listOrganizations()
  if (!orgsRes.ok) {
    return {
      success: false,
      message: `Could not list HackerOne organizations (GET /me/organizations → HTTP ${orgsRes.status}). Check the API credential.`,
    }
  }
  const organizations = orgsRes.items

  const programsRes = await client.listPrograms()
  if (!programsRes.ok) {
    return {
      success: false,
      message: `Could not list HackerOne programs (GET /me/programs → HTTP ${programsRes.status}). Check the API credential.`,
    }
  }
  const programs = programsRes.items

  const previous: RollbackEntry[] = []
  const applied: string[] = []
  const failures: string[] = []

  for (const [organizationHandle, groupItems] of groupItemsByOrganization(items)) {
    const organizationId = findOrganizationId(organizations, organizationHandle)
    if (!organizationId) {
      failures.push(`organization "${organizationHandle}": not found among the credential's organizations (GET /me/organizations)`)
      for (const item of groupItems) {
        previous.push({
          organizationHandle,
          organizationId: null,
          programHandle: str(item.fields.program_handle),
          programId: null,
          assetIdentifier: str(item.fields.asset_identifier),
          assetId: null,
          scopeId: null,
          existed: false,
          previousAttributes: null,
        })
      }
      continue
    }

    for (const item of groupItems) {
      const programHandle = str(item.fields.program_handle)
      const assetIdentifier = str(item.fields.asset_identifier)
      if (!programHandle || !assetIdentifier) continue
      const label = `${organizationHandle}/${programHandle}/${assetIdentifier}`

      const programId = findProgramId(programs, programHandle)
      if (!programId) {
        failures.push(`attachment "${label}": program not found among the credential's programs (GET /me/programs)`)
        previous.push({
          organizationHandle,
          organizationId,
          programHandle,
          programId: null,
          assetIdentifier,
          assetId: null,
          scopeId: null,
          existed: false,
          previousAttributes: null,
        })
        continue
      }

      const asset = pickAssetByIdentifier(await findAsset(client, organizationId, assetIdentifier), assetIdentifier)
      if (!asset?.id) {
        failures.push(`attachment "${label}": asset is not a known organization asset (GET /organizations/${organizationId}/assets) — create it first with the Assets configuration type`)
        previous.push({
          organizationHandle,
          organizationId,
          programHandle,
          programId,
          assetIdentifier,
          assetId: null,
          scopeId: null,
          existed: false,
          previousAttributes: null,
        })
        continue
      }
      const assetId = String(asset.id)

      const liveScopes = scopesByIdentifier(await listScopes(client, programId))
      const existingScope = liveScopes.get(normalizeIdentifier(assetIdentifier))
      const scopeId = existingScope?.id != null ? String(existingScope.id) : null

      const attributes = buildAssetScopeAttributes(item.fields)
      const notify = buildNotifyFlag(item.fields)
      const entry: RollbackEntry = {
        organizationHandle,
        organizationId,
        programHandle,
        programId,
        assetIdentifier,
        assetId,
        scopeId,
        existed: Boolean(existingScope),
        previousAttributes: existingScope
          ? {
              eligible_for_submission: Boolean(existingScope.attributes?.eligible_for_submission),
              eligible_for_bounty: Boolean(existingScope.attributes?.eligible_for_bounty),
              instruction: (existingScope.attributes?.instruction as string | undefined) ?? null,
            }
          : null,
      }

      try {
        if (scopeId) {
          const res = await client.put(
            `/organizations/${encodeURIComponent(organizationId)}/assets/${encodeURIComponent(assetId)}/scopes/${encodeURIComponent(scopeId)}`,
            updateAssetScopeBody(attributes, notify),
          )
          const error = hackeroneWriteError(res)
          if (error) {
            failures.push(`update "${label}": ${error}`)
            previous.push(entry)
            continue
          }
        } else {
          const res = await client.post(
            `/organizations/${encodeURIComponent(organizationId)}/assets/${encodeURIComponent(assetId)}/scopes`,
            createAssetScopeBody(attributes, notify, programId),
          )
          const error = hackeroneWriteError(res)
          if (error) {
            failures.push(`create "${label}": ${error}`)
            previous.push(entry)
            continue
          }
        }
        previous.push(entry)
        applied.push(label)
      } catch (error) {
        failures.push(`"${label}": ${error instanceof Error ? error.message : 'Unknown error'}`)
        previous.push(entry)
      }
    }
  }

  if (failures.length > 0) {
    return {
      success: false,
      message: `Asset-scope deploy applied ${applied.length} attachment(s); ${failures.length} error(s): ${failures.join('; ')}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }

  return {
    success: true,
    message: `Applied ${applied.length} asset scope attachment(s): ${applied.join(', ') || '(none)'}`,
    artifacts: { applied },
    rollbackData: { previous },
  }
}
