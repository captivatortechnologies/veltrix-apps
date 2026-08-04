import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAuthentikUrl, buildApiBase, resolveApiToken, resolveVerifyTls, findByName } from '../../lib/authentikApi'
import {
  STAGE_ENDPOINT_SEGMENT,
  readManagedFields,
  readStageType,
  sameManagedFields,
  snapshotManagedFields,
  type AuthentikStage,
} from './_shared'

/** Drift for stages: re-find by name WITHIN the item's own type's endpoint, compare managed fields. */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, deployedConfig, settings } = ctx
  const items = deployedConfig.items ?? deployedConfig.sections ?? []
  const diffs: DriftDiff[] = []

  const token = resolveApiToken(credential)
  if (!token) return { hasDrift: false, diffs }

  const base = buildApiBase(buildAuthentikUrl(component, connectivity, connectivityProvider))
  const verifyTls = resolveVerifyTls(settings)

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue
    const type = readStageType(item.fields.type)
    const listUrl = `${base}/stages/${STAGE_ENDPOINT_SEGMENT[type]}/`

    let live: AuthentikStage | null
    try {
      live = await findByName<AuthentikStage>(listUrl, token, name, { verifyTls })
    } catch {
      continue
    }

    const label = `${name} (${type})`
    if (!live) {
      diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    const expected = readManagedFields(item.fields)
    const actual = snapshotManagedFields(live, type)
    if (sameManagedFields(expected, actual)) continue

    // Coarse: flag the whole stage as changed rather than diffing every
    // type-specific field individually (the field set varies by type).
    diffs.push({ field: label, expected: 'matches declared configuration', actual: 'differs from declared configuration', severity: 'warning' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
