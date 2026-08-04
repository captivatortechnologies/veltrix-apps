import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { driftTable } from '../../lib/tableConfig'
import { trimStr } from '../../lib/tableRecords'
import { spec, isPasswordType } from './_shared'

/**
 * Drift = declared property fields vs the live sys_properties record, with
 * one filter: ServiceNow never returns a password/password2 property's real
 * value (GET always returns a masked placeholder), so a `value` diff on a
 * password-type item is always a false positive — this app cannot ever know
 * whether the live secret matches what's declared. Every OTHER field (type,
 * description, is_private, ignore_cache, read/write roles) is still compared
 * normally.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const result = await driftTable(ctx, spec)

  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const passwordNames = new Set(
    items.filter((item) => isPasswordType(item.fields.type)).map((item) => trimStr(item.fields.name)),
  )
  if (passwordNames.size === 0) return result

  const diffs = result.diffs.filter((diff) => {
    if (!diff.field.endsWith('.value')) return true
    const label = diff.field.slice(0, -'.value'.length)
    return !passwordNames.has(label)
  })

  return { hasDrift: diffs.length > 0, diffs }
}
