import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient } from '../../lib/zscaler'
import { attachDriftActor, veltrixActorLogins } from '../lib/zscalerAudit'
import { listAdminUsers } from './deploy'
import { extractAdminUserSpecs } from './validate'

/**
 * Detect drift between the deployed admin user configuration and the live
 * tenant. Re-finds each declared account by loginName and diffs the managed
 * fields: a missing account is critical drift, and email / disabled are compared.
 *
 * ⚠ The password is NEVER diffed — it is a write-only secret ZIA never returns,
 * so there is nothing to compare and it must not surface as drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  const specs = extractAdminUserSpecs(ctx.deployedConfig).filter((s) => s.loginName)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listAdminUsers(client)
    const byLoginName = new Map(live.filter((u) => u.loginName).map((u) => [u.loginName as string, u]))

    for (const spec of specs) {
      const found = byLoginName.get(spec.loginName)
      if (!found) {
        diffs.push({ field: spec.loginName, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      const before = diffs.length

      const liveEmail = (typeof found.email === 'string' ? found.email : '').trim()
      if (spec.email !== liveEmail) {
        diffs.push({
          field: `${spec.loginName}.email`,
          expected: spec.email || 'not set',
          actual: liveEmail || 'not set',
          severity: 'info',
        })
      }

      const liveDisabled = found.disabled === true
      if (spec.disabled !== liveDisabled) {
        diffs.push({
          field: `${spec.loginName}.disabled`,
          expected: String(spec.disabled),
          actual: String(liveDisabled),
          severity: 'warning',
        })
      }
      attachDriftActor(diffs.slice(before), found, { excludeActorLogins })
    }
  } catch (error) {
    diffs.push({
      field: 'zia',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
