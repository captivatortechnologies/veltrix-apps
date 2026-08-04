import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildHackeroneClient, hackeroneWriteError, type HackerOneClient } from '../../lib/hackeroneApi'
import {
  buildAssetCreateAttributes,
  buildAssetUpdateAttributes,
  assetWriteBody,
  groupItemsByOrganization,
  findOrganizationId,
  pickAssetByIdentifier,
  str,
  type AssetResource,
  type AssetUpdateAttributes,
} from './_shared'

/**
 * Deploy HackerOne (organization) Assets over the HackerOne API (v1) — the
 * confirmed, non-deprecated successor to the program-level structured-scope
 * CREATE/UPDATE endpoints (removed from HackerOne's docs 2026-04-07).
 *
 *   resolve organization: GET  /me/organizations                                    → handle → id
 *   read (upsert):        GET  /organizations/{id}/assets?filter[identifier]=...   → exact match
 *   create:                POST /organizations/{id}/assets                          { data: { type, attributes } }
 *   update:                PUT  /organizations/{id}/assets/{assetId}                { data: { type, attributes } } (no asset_type/identifier — immutable)
 *
 * Assets are grouped by organization_handle, each handle resolved to its
 * organization id, and each asset upserted by `identifier` WITHIN that
 * organization via the `filter[identifier]` query (avoids paginating the whole
 * org's asset list, which HackerOne caps at 10,000 via offset pagination).
 * rollbackData records, per asset, whether it already existed, its id, and the
 * prior UPDATE-shape attributes — so rollback can restore the prior state or
 * archive what we created.
 *
 * FLAGGED — the Assets endpoints do not state a "Required permissions" scope in
 * HackerOne's published docs. Verify against a live token before relying on it.
 *   Confirmed: https://api.hackerone.com/customer-resources/ (Assets)
 */
interface RollbackEntry {
  organizationHandle: string
  organizationId: string | null
  identifier: string
  assetId: string | null
  existed: boolean
  previousAttributes: Partial<AssetUpdateAttributes> | null
}

/** Look up a single organization asset by exact identifier (best-effort). */
async function findAsset(client: HackerOneClient, organizationId: string, identifier: string): Promise<AssetResource[]> {
  try {
    const res = await client.getAll<Record<string, unknown>>(`/organizations/${encodeURIComponent(organizationId)}/assets`, {
      'filter[identifier]': identifier,
    })
    return res.ok ? res.items : []
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for asset deployment' }
  }

  const built = buildHackeroneClient(credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previous: RollbackEntry[] = []
  const applied: string[] = []
  const failures: string[] = []

  const orgsRes = await client.listOrganizations()
  if (!orgsRes.ok) {
    return {
      success: false,
      message: `Could not list HackerOne organizations (GET /me/organizations → HTTP ${orgsRes.status}). Check the API credential.`,
    }
  }
  const organizations = orgsRes.items

  for (const [handle, groupItems] of groupItemsByOrganization(items)) {
    const organizationId = findOrganizationId(organizations, handle)
    if (!organizationId) {
      failures.push(`organization "${handle}": not found among the credential's organizations (GET /me/organizations)`)
      for (const item of groupItems) {
        previous.push({
          organizationHandle: handle,
          organizationId: null,
          identifier: str(item.fields.identifier),
          assetId: null,
          existed: false,
          previousAttributes: null,
        })
      }
      continue
    }

    for (const item of groupItems) {
      const identifier = str(item.fields.identifier)
      if (!identifier) continue
      const label = `${handle}/${identifier}`

      const existing = pickAssetByIdentifier(await findAsset(client, organizationId, identifier), identifier)
      const entry: RollbackEntry = {
        organizationHandle: handle,
        organizationId,
        identifier,
        assetId: existing?.id != null ? String(existing.id) : null,
        existed: Boolean(existing),
        previousAttributes: existing ? buildAssetUpdateAttributes(existing.attributes ?? {}) : null,
      }

      try {
        if (existing?.id != null) {
          const res = await client.put(
            `/organizations/${encodeURIComponent(organizationId)}/assets/${encodeURIComponent(String(existing.id))}`,
            assetWriteBody(buildAssetUpdateAttributes(item.fields)),
          )
          const error = hackeroneWriteError(res)
          if (error) {
            failures.push(`update "${label}": ${error}`)
            previous.push(entry)
            continue
          }
        } else {
          const res = await client.post(
            `/organizations/${encodeURIComponent(organizationId)}/assets`,
            assetWriteBody(buildAssetCreateAttributes(item.fields)),
          )
          const error = hackeroneWriteError(res)
          if (error) {
            failures.push(`create "${label}": ${error}`)
            previous.push(entry)
            continue
          }
          const created = res.json as { id?: string; data?: { id?: string } } | null
          entry.assetId = (created?.id ?? created?.data?.id) != null ? String(created?.id ?? created?.data?.id) : null
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
      message: `Asset deploy applied ${applied.length} asset(s); ${failures.length} error(s): ${failures.join('; ')}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }

  return {
    success: true,
    message: `Applied ${applied.length} asset(s): ${applied.join(', ') || '(none)'}`,
    artifacts: { applied },
    rollbackData: { previous },
  }
}
