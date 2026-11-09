import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { driftResult, missingDiff, unreadableDrift } from '../lib/drift'
import { resolveStore } from '../lib/store'
import { inspectPacks } from './inspect'

/** A pack drifts when a member policy is gone, uncompiled or no longer registered for the account. */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const store = resolveStore(ctx)
  if (!store) return unreadableDrift()

  const diffs: DriftDiff[] = []
  for (const { pack, members } of await inspectPacks(store, ctx.deployedConfig, ctx.component.id)) {
    for (const member of members) {
      const scope = `${pack.name}.${member.name}`
      if (!member.exists) diffs.push(missingDiff(scope, 'member policy'))
      else if (!member.registered) diffs.push(missingDiff(`${scope}.account`, `registration for ${ctx.component.hostname}`))
      else if (!member.compiled) diffs.push({ field: `${scope}.compiledYaml`, expected: 'compiled', actual: 'not compiled', severity: 'warning' })
    }
  }
  return driftResult(diffs)
}
