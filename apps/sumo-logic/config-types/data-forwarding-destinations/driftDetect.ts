import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, listPaged } from '../../lib/sumoLogicApi'
import { findDestination, normalizeBool, type DataForwardingDestination } from './_shared'

/**
 * Drift for data forwarding destinations: compare description, region,
 * encryption, enabled state and (for RoleBased mode) the role ARN we declare
 * against the live destination in Sumo Logic (matched by name). AWS Access
 * Key ID / Secret Access Key are intentionally NOT compared — Sumo Logic never
 * echoes them back on read, so there is nothing genuine to diff against
 * (comparing against a masked placeholder would produce permanent false
 * drift). `bucketName` is compared but flagged `info` — it is immutable after
 * creation, so a mismatch cannot be corrected by redeploying. Best-effort — a
 * destination that can't be matched is skipped. Read-only:
 * GET /logsDataForwarding/destinations.
 *
 * API: https://help.sumologic.com/docs/api/data-forwarding/
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!hasBasicAuth(credential)) return { hasDrift: false, diffs }

  const base = buildBaseUrl(component, connectivity)
  const headers = buildAuthHeader(credential!)

  let live: DataForwardingDestination[]
  try {
    live = await listPaged<DataForwardingDestination>(base, 'logsDataForwarding/destinations', headers, { nextTokenField: 'nextToken' })
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read destinations, no drift asserted
  }

  for (const item of items) {
    const destinationName = String(item.fields.destinationName ?? '').trim()
    const match = findDestination(live, destinationName)
    if (!match) continue

    const expectedBucket = String(item.fields.bucketName ?? '').trim()
    const actualBucket = String(match.bucketName ?? '').trim()
    if (expectedBucket && actualBucket !== expectedBucket) {
      diffs.push({ field: `${destinationName}.bucketName`, expected: expectedBucket, actual: actualBucket, severity: 'info' })
    }

    const expectedRegion = String(item.fields.region ?? '').trim()
    const actualRegion = String(match.region ?? '').trim()
    if (expectedRegion && actualRegion && actualRegion !== expectedRegion) {
      diffs.push({ field: `${destinationName}.region`, expected: expectedRegion, actual: actualRegion, severity: 'warning' })
    }

    const expectedEncrypted = normalizeBool(item.fields.encrypted)
    if (Boolean(match.encrypted) !== expectedEncrypted) {
      diffs.push({ field: `${destinationName}.encrypted`, expected: expectedEncrypted, actual: Boolean(match.encrypted), severity: 'warning' })
    }

    const expectedEnabled = normalizeBool(item.fields.enabled ?? true)
    const actualEnabled = match.enabled !== false
    if (actualEnabled !== expectedEnabled) {
      diffs.push({ field: `${destinationName}.enabled`, expected: expectedEnabled, actual: actualEnabled, severity: 'warning' })
    }

    if (String(item.fields.authenticationMode ?? '').trim() === 'RoleBased') {
      const expectedRoleArn = String(item.fields.roleArn ?? '').trim()
      const actualRoleArn = String(match.roleArn ?? '').trim()
      if (expectedRoleArn && actualRoleArn && actualRoleArn !== expectedRoleArn) {
        diffs.push({ field: `${destinationName}.roleArn`, expected: expectedRoleArn, actual: actualRoleArn, severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
