import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildTenableClient } from '../../lib/tenable'
import { attachDriftActor, veltrixActorLogins } from '../lib/tenableAudit'
import { findUser } from './deploy'
import { extractUserSpecs } from './validate'

/**
 * Detect drift between the deployed user configuration and the live tenant.
 * Re-finds each declared user by its username and diffs the managed NON-SECRET
 * fields: name, permissions (role level) and enabled.
 *
 * The PASSWORD is deliberately NEVER diffed. Tenable stores it write-only and
 * never returns it on GET, so there is nothing to read back and compare against
 * — a changed password can only ever be re-applied on deploy, never detected as
 * drift. Diffing it would be impossible (the live value is unreadable) and would
 * produce a permanent false-positive.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractUserSpecs(ctx.deployedConfig).filter((s) => s.username)
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  for (const spec of specs) {
    const before = diffs.length
    try {
      const live = await findUser(client, spec.username)

      if (!live) {
        diffs.push({ field: spec.username, expected: 'exists', actual: 'missing', severity: 'critical' })
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.username, excludeActorLogins })
        continue
      }

      const liveName = (typeof live.name === 'string' ? live.name : '').trim()
      if (spec.name !== liveName) {
        diffs.push({
          field: `${spec.username}.name`,
          expected: spec.name || 'not set',
          actual: liveName || 'not set',
          severity: 'info',
        })
      }

      // Role level — a privilege change is meaningful, so flag it as a warning.
      if (live.permissions !== undefined && live.permissions !== spec.permissions) {
        diffs.push({
          field: `${spec.username}.permissions`,
          expected: String(spec.permissions),
          actual: String(live.permissions),
          severity: 'warning',
        })
      }

      // enabled — an unexpectedly (dis)abled account is a security-relevant drift.
      if (live.enabled !== undefined && live.enabled !== spec.enabled) {
        diffs.push({
          field: `${spec.username}.enabled`,
          expected: String(spec.enabled),
          actual: String(live.enabled),
          severity: 'warning',
        })
      }

      // NOTE: password is intentionally NOT compared here — Tenable never
      // returns it, so it cannot be read back to detect drift (see the header).

      // Attribute every diff this user produced to the last change (once).
      await attachDriftActor(client, diffs.slice(before), {
        targetId: live.id,
        targetName: spec.username,
        excludeActorLogins,
      })
    } catch (error) {
      diffs.push({
        field: spec.username,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
