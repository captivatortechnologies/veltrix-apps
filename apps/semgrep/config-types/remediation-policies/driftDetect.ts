import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSemgrepClient, remediationPoliciesBundleFromResponse } from '../../lib/semgrepApi'
import { extractRemediationPolicySpecs, isCompleteSpec, policiesEqual, policyFromSpec } from './_shared'

/**
 * Drift for Remediation Policies: compare the declared whole bundle against the
 * live one (GET .../remediation-policies). Flags a declared policy that is
 * missing or changed live, AND a live (non-system-managed) policy that isn't
 * declared at all — a strict apply would delete it. Best-effort — a deployment
 * that can't be read is skipped rather than raising false drift. Read-only.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { credential, settings, canvas } = ctx
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const built = buildSemgrepClient(credential, settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built
  if (!client.hasSlug) return { hasDrift: false, diffs }

  let deploymentId: number
  try {
    const resolved = await client.resolveDeploymentId()
    if ('error' in resolved) return { hasDrift: false, diffs }
    deploymentId = resolved.id
  } catch {
    return { hasDrift: false, diffs }
  }

  const specs = extractRemediationPolicySpecs(canvas).filter(isCompleteSpec)

  let res
  try {
    res = await client.getRemediationPolicies(deploymentId)
  } catch {
    return { hasDrift: false, diffs }
  }
  if (!res.ok) return { hasDrift: false, diffs }

  const live = remediationPoliciesBundleFromResponse(res)
  if (!live) return { hasDrift: false, diffs }

  const liveBySlug = new Map((live.policies ?? []).filter((p) => p.slug).map((p) => [p.slug as string, p]))

  for (const spec of specs) {
    const declared = policyFromSpec(spec)
    const livePolicy = liveBySlug.get(spec.slug)
    if (!livePolicy) {
      diffs.push({ field: spec.slug, expected: 'present', actual: 'missing', severity: 'warning' })
      continue
    }
    if (!policiesEqual(declared, livePolicy)) {
      diffs.push({ field: spec.slug, expected: JSON.stringify(declared), actual: JSON.stringify(livePolicy), severity: 'warning' })
    }
    liveBySlug.delete(spec.slug)
  }

  // Live policies not declared on the canvas — a strict apply would delete them.
  for (const extraSlug of liveBySlug.keys()) {
    diffs.push({ field: extraSlug, expected: 'absent (not declared on the canvas)', actual: 'present', severity: 'warning' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
