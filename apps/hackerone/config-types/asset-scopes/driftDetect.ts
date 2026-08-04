import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildHackeroneClient, type HackerOneClient } from '../../lib/hackeroneApi'
import {
  buildAssetScopeAttributes,
  groupItemsByOrganization,
  findOrganizationId,
  findProgramId,
  scopesByIdentifier,
  normalizeIdentifier,
  toBool,
  str,
  type LiveScope,
} from './_shared'

/**
 * Drift for Asset Scopes: for each declared attachment, confirm the program
 * still carries a structured scope for the asset and that eligibility /
 * instruction match what we declare. Read-only:
 *   GET /me/organizations                                → resolve org handles → ids (existence only)
 *   GET /me/programs                                     → resolve program handles → ids
 *   GET /programs/{id}/structured_scopes                → live scope by asset identifier
 *
 * Best-effort — a program or attachment that can't be resolved / read is
 * reported as missing rather than raising noisy false drift. `notify_
 * subscribers_*` is never compared — HackerOne does not return it on read (see
 * ./_shared for the known create/update key-name inconsistency).
 */
async function listScopes(client: HackerOneClient, programId: string): Promise<LiveScope[]> {
  try {
    const res = await client.getAll<{ asset_identifier?: string }>(`/programs/${encodeURIComponent(programId)}/structured_scopes`)
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
  let programs
  try {
    const [orgsRes, programsRes] = await Promise.all([client.listOrganizations(), client.listPrograms()])
    if (!orgsRes.ok || !programsRes.ok) return { hasDrift: false, diffs }
    organizations = orgsRes.items
    programs = programsRes.items
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const [organizationHandle, groupItems] of groupItemsByOrganization(items)) {
    const organizationId = findOrganizationId(organizations, organizationHandle)
    if (!organizationId) {
      diffs.push({ field: organizationHandle, expected: 'organization present', actual: 'not found', severity: 'warning' })
      continue
    }

    for (const item of groupItems) {
      const programHandle = str(item.fields.program_handle)
      const assetIdentifier = str(item.fields.asset_identifier)
      if (!programHandle || !assetIdentifier) continue
      const label = `${organizationHandle}/${programHandle}/${assetIdentifier}`

      const programId = findProgramId(programs, programHandle)
      if (!programId) {
        diffs.push({ field: label, expected: 'program present', actual: 'not found', severity: 'warning' })
        continue
      }

      const live = scopesByIdentifier(await listScopes(client, programId))
      const match = live.get(normalizeIdentifier(assetIdentifier))
      if (!match) {
        diffs.push({ field: label, expected: 'attached', actual: 'not attached', severity: 'warning' })
        continue
      }

      const desired = buildAssetScopeAttributes(item.fields)
      const actual = match.attributes ?? {}

      if (actual.eligible_for_submission !== undefined && toBool(actual.eligible_for_submission) !== desired.eligible_for_submission) {
        diffs.push({
          field: `${label}.eligible_for_submission`,
          expected: desired.eligible_for_submission,
          actual: toBool(actual.eligible_for_submission),
          severity: 'warning',
        })
      }
      if (actual.eligible_for_bounty !== undefined && toBool(actual.eligible_for_bounty) !== desired.eligible_for_bounty) {
        diffs.push({
          field: `${label}.eligible_for_bounty`,
          expected: desired.eligible_for_bounty,
          actual: toBool(actual.eligible_for_bounty),
          severity: 'warning',
        })
      }
      const liveInstruction = typeof actual.instruction === 'string' ? actual.instruction : null
      if (liveInstruction !== desired.instruction) {
        diffs.push({ field: `${label}.instruction`, expected: desired.instruction, actual: liveInstruction, severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
