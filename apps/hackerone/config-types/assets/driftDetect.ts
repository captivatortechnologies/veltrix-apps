import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildHackeroneClient, type HackerOneClient } from '../../lib/hackeroneApi'
import {
  buildAssetCreateAttributes,
  groupItemsByOrganization,
  findOrganizationId,
  pickAssetByIdentifier,
  str,
  type AssetResource,
} from './_shared'

/**
 * Drift for Assets: for each declared asset, confirm it still exists in its
 * organization and that its mutable attributes (description, max_severity, CIA
 * requirements, reference) match what we declare. `asset_type` is immutable
 * post-creation, so a mismatch there is reported at `critical` severity — it
 * cannot be corrected by a normal redeploy (the identifier would need to move to
 * a differently-typed asset). Read-only:
 *   GET /me/organizations                                    → resolve handles → ids
 *   GET /organizations/{id}/assets?filter[identifier]=...   → exact live match
 *
 * Best-effort — an organization or asset that can't be resolved / read is
 * reported as missing rather than raising noisy false drift.
 */
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

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const built = buildHackeroneClient(credential, settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  let organizations
  try {
    const res = await client.listOrganizations()
    if (!res.ok) return { hasDrift: false, diffs }
    organizations = res.items
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const [handle, groupItems] of groupItemsByOrganization(items)) {
    const organizationId = findOrganizationId(organizations, handle)
    if (!organizationId) {
      diffs.push({ field: handle, expected: 'organization present', actual: 'not found', severity: 'warning' })
      continue
    }

    for (const item of groupItems) {
      const identifier = str(item.fields.identifier)
      if (!identifier) continue
      const label = `${handle}/${identifier}`

      const match = pickAssetByIdentifier(await findAsset(client, organizationId, identifier), identifier)
      if (!match) {
        diffs.push({ field: label, expected: 'present', actual: 'missing', severity: 'warning' })
        continue
      }

      const desired = buildAssetCreateAttributes(item.fields)
      const actual = match.attributes ?? {}

      if (str(actual.asset_type) && str(actual.asset_type) !== desired.asset_type) {
        diffs.push({ field: `${label}.asset_type`, expected: desired.asset_type, actual: str(actual.asset_type), severity: 'critical' })
      }
      if (str(actual.description ?? '') !== (desired.description ?? '')) {
        diffs.push({ field: `${label}.description`, expected: desired.description, actual: actual.description ?? null, severity: 'warning' })
      }
      if (str(actual.max_severity) && str(actual.max_severity) !== desired.max_severity) {
        diffs.push({ field: `${label}.max_severity`, expected: desired.max_severity, actual: str(actual.max_severity), severity: 'warning' })
      }
      if (str(actual.confidentiality_requirement) && str(actual.confidentiality_requirement) !== desired.confidentiality_requirement) {
        diffs.push({
          field: `${label}.confidentiality_requirement`,
          expected: desired.confidentiality_requirement,
          actual: str(actual.confidentiality_requirement),
          severity: 'warning',
        })
      }
      if (str(actual.integrity_requirement) && str(actual.integrity_requirement) !== desired.integrity_requirement) {
        diffs.push({
          field: `${label}.integrity_requirement`,
          expected: desired.integrity_requirement,
          actual: str(actual.integrity_requirement),
          severity: 'warning',
        })
      }
      if (str(actual.availability_requirement) && str(actual.availability_requirement) !== desired.availability_requirement) {
        diffs.push({
          field: `${label}.availability_requirement`,
          expected: desired.availability_requirement,
          actual: str(actual.availability_requirement),
          severity: 'warning',
        })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
