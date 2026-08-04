import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSemgrepClient, detectionPolicyBundleFromResponse, type DetectionPolicyProduct } from '../../lib/semgrepApi'
import { stringSetEqual } from '../../lib/canvas'
import { exceptionsEqual, extractDetectionPolicySpecs, isDetectionPolicyProduct } from './_shared'

/**
 * Drift for Detection Policy: compare the declared rulesets / rules / disabled /
 * exceptions per product against the live bundle
 * (GET .../detection-policy/{product}). Best-effort — a product that can't be
 * read (transient error / not enabled) is skipped rather than raising false
 * drift. Read-only.
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

  const specs = extractDetectionPolicySpecs(canvas).filter((s) => isDetectionPolicyProduct(s.product) && s.exceptions !== null)

  for (const spec of specs) {
    const product = spec.product as DetectionPolicyProduct
    let res
    try {
      res = await client.getDetectionPolicy(deploymentId, product)
    } catch {
      continue // best-effort: can't read, no drift asserted
    }
    if (!res.ok) continue

    const live = detectionPolicyBundleFromResponse(res)
    if (!live) continue

    if (!stringSetEqual(spec.rulesets, live.rulesets ?? [])) {
      diffs.push({
        field: `${product}.rulesets`,
        expected: spec.rulesets.join(', '),
        actual: (live.rulesets ?? []).join(', '),
        severity: 'warning',
      })
    }
    if (!stringSetEqual(spec.rules, live.rules ?? [])) {
      diffs.push({
        field: `${product}.rules`,
        expected: spec.rules.join(', '),
        actual: (live.rules ?? []).join(', '),
        severity: 'warning',
      })
    }
    if (!stringSetEqual(spec.disabled, live.disabled ?? [])) {
      diffs.push({
        field: `${product}.disabled`,
        expected: spec.disabled.join(', '),
        actual: (live.disabled ?? []).join(', '),
        severity: 'warning',
      })
    }
    if (!exceptionsEqual(spec.exceptions ?? [], live.exceptions ?? [])) {
      diffs.push({
        field: `${product}.exceptions`,
        expected: JSON.stringify(spec.exceptions ?? []),
        actual: JSON.stringify(live.exceptions ?? []),
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
