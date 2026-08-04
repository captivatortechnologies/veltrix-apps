import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildCortexClient } from '../../lib/cortexXdrApi'
import { SCALAR_SETTING_GROUPS, ACTION_CENTER_EXPIRATION_GET_PATH, buildScalarGroupRequest, scalarGroupFromReply, parseActionCenterExpiration } from './_shared'
import { readBoolean, readOptionalInt } from '../../lib/fields'

/**
 * Drift for agent configuration settings: for each of the 9 scalar setting
 * groups, GET the live value and compare every boolean/integer key we declare;
 * for action_center_expiration, compare only the action-type keys the canvas
 * declares (a partial-merge field — see _shared.ts). Best-effort — a group that
 * can't be read (transient error) is skipped rather than raising false drift.
 * Read-only: 9x GET /configurations/agent/<group>/ plus (when declared) GET
 * /configurations/agent/action_center_expiration/.
 *
 * VERIFY every GET response shape + field name against a live Cortex XDR
 * tenant.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const item = items[0]
  const diffs: DriftDiff[] = []
  if (!item) return { hasDrift: false, diffs }

  if (!credential) return { hasDrift: false, diffs }

  const built = buildCortexClient(component?.hostname, credential, settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  for (const group of SCALAR_SETTING_GROUPS) {
    let live: Record<string, unknown>
    try {
      const res = await client.call(group.getPath, {})
      if (!res.ok) continue // best-effort: can't read this group, skip it rather than assert drift
      live = scalarGroupFromReply(res.reply)
    } catch {
      continue
    }
    const desired = buildScalarGroupRequest(group, item.fields)

    for (const key of group.booleanKeys) {
      const expected = readBoolean(desired[key], false)
      const actual = readBoolean(live[key], false)
      if (expected !== actual) {
        diffs.push({ field: `${group.key}.${key}`, expected, actual, severity: 'warning' })
      }
    }
    for (const key of group.intKeys) {
      const expected = readOptionalInt(desired[key])
      const actual = readOptionalInt(live[key])
      if (expected !== undefined && expected !== actual) {
        diffs.push({ field: `${group.key}.${key}`, expected, actual, severity: 'warning' })
      }
    }
  }

  const desiredActionMap = parseActionCenterExpiration(item.fields.action_center_expiration)
  if (Object.keys(desiredActionMap).length > 0) {
    try {
      const res = await client.call(ACTION_CENTER_EXPIRATION_GET_PATH, {})
      if (res.ok) {
        const liveMap = scalarGroupFromReply(res.reply)
        for (const [key, expected] of Object.entries(desiredActionMap)) {
          const actual = readOptionalInt(liveMap[key])
          if (expected !== actual) {
            diffs.push({ field: `action_center_expiration.${key}`, expected, actual, severity: 'warning' })
          }
        }
      }
    } catch {
      // best-effort: can't read, no drift asserted on this field
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
