import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPPClient } from '../../lib/proofpoint'
import { extractIdpSpecs, idpKey, listIdps, type LiveIdp } from './validate'

/**
 * Detect drift between the deployed Identity Providers and the live org.
 * Re-finds each declared IDP by name and diffs the managed fields; a missing IDP
 * is critical drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildPPClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractIdpSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listIdps(client)
    const byKey = new Map<string, LiveIdp>(live.filter((i) => i.name).map((i) => [idpKey(i.name as string), i]))

    for (const spec of specs) {
      const found = byKey.get(idpKey(spec.name))
      if (!found) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      if ((found.is_active ?? true) !== spec.isActive) {
        diffs.push({ field: `${spec.name}.is_active`, expected: spec.isActive, actual: found.is_active ?? true, severity: 'warning' })
      }
      if ((found.idp_entity_id ?? '') !== spec.idpEntityId) {
        diffs.push({ field: `${spec.name}.idp_entity_id`, expected: spec.idpEntityId || 'not set', actual: found.idp_entity_id || 'not set', severity: 'warning' })
      }
      if ((found.idp_login_url ?? '') !== spec.idpLoginUrl) {
        diffs.push({ field: `${spec.name}.idp_login_url`, expected: spec.idpLoginUrl || 'not set', actual: found.idp_login_url || 'not set', severity: 'warning' })
      }
      if ((found.idp_public_cert ?? '') !== spec.idpPublicCert) {
        diffs.push({ field: `${spec.name}.idp_public_cert`, expected: 'declared certificate', actual: 'different or missing certificate', severity: 'warning' })
      }
    }
  } catch (error) {
    diffs.push({
      field: 'proofpoint',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
