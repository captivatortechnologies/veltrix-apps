import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAkamaiClient, parseJson } from '../../lib/akamaiApi'
import { contentFromResponse, effectiveVersion, findPolicy, policiesPath, readActivationFields, type CloudletPolicy } from './_shared'

/**
 * Drift for Cloudlets policy activation: compare the declared policy version
 * against what's currently EFFECTIVE on the target network (matched by policy
 * name). Best-effort — a policy that can't be matched (missing / transient
 * error) is skipped rather than raising false drift. Read-only:
 * GET /cloudlets/v3/policies.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const built = buildAkamaiClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  let live: CloudletPolicy[]
  try {
    const res = await client.request('GET', policiesPath, { query: { size: 1000 } })
    if (!res.ok) return { hasDrift: false, diffs }
    live = contentFromResponse<CloudletPolicy>(parseJson<unknown>(res.body))
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const fields = readActivationFields(item.fields)
    const policy = findPolicy(live, fields.policyName)
    if (!policy) continue

    const label = `${fields.policyName} → ${fields.network}`
    const effective = effectiveVersion(policy, fields.network)

    if (effective !== fields.policyVersion) {
      diffs.push({ field: label, expected: `v${fields.policyVersion}`, actual: effective == null ? 'never activated' : `v${effective}`, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
