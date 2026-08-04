import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { ersBase, buildErsResourceClient, readIseSettings, hasUsableCredential, type IseEndpoint, type EndPointGroup } from '../../lib/iseApi'
import { extractSpecs } from './_shared'

/**
 * Drift for endpoints: a declared endpoint missing from ISE is critical
 * drift; a description or group-assignment mismatch is a warning
 * (`group_name` is re-resolved to an id here the same way deploy.ts does).
 * Read-only. Best-effort — an endpoint (or its referenced group) that can't
 * be read is skipped rather than raising false drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!hasUsableCredential(credential)) return { hasDrift: false, diffs }

  const settings = readIseSettings(ctx.settings)
  const base = ersBase(component, connectivity, connectivityProvider)
  const client = buildErsResourceClient<IseEndpoint>(base, 'endpoint', 'ERSEndPoint', credential, settings, { identityFilterField: 'mac' })
  const groupClient = buildErsResourceClient<EndPointGroup>(base, 'endpointgroup', 'EndPointGroup', credential, settings)

  for (const item of items) {
    const spec = extractSpecs([item])[0]
    if (!spec.mac) continue

    let existing
    try {
      existing = await client.findByName(spec.mac)
    } catch {
      continue
    }

    if (!existing) {
      diffs.push({ field: `${spec.mac}`, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }

    let live
    try {
      live = await client.getById(existing.id)
    } catch {
      continue
    }
    if (!live) continue

    const expectedDescription = spec.description
    const actualDescription = String(live.description ?? '').trim()
    if (expectedDescription !== actualDescription) {
      diffs.push({ field: `${spec.mac}.description`, expected: expectedDescription, actual: actualDescription, severity: 'warning' })
    }

    if (spec.groupName) {
      let expectedGroupId = ''
      try {
        const group = await groupClient.findByName(spec.groupName)
        expectedGroupId = group?.id ?? ''
      } catch {
        continue
      }
      const actualGroupId = String(live.groupId ?? '').trim()
      if (expectedGroupId && expectedGroupId !== actualGroupId) {
        diffs.push({ field: `${spec.mac}.group_name`, expected: spec.groupName, actual: actualGroupId, severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
