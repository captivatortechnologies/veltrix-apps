import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildAkeylessClient, boolFlag } from '../../lib/akeyless'
import { getK8sAuthConfig } from './deploy'
import { extractK8sAuthConfigSpecs } from './validate'

/**
 * Detect drift for K8s auth configs, comparing the NON-SENSITIVE fields
 * Akeyless returns (access-id, K8s host, issuer, cluster type, auth type,
 * token expiry). Signing Key / Token Reviewer JWT / Rancher API Key / K8s
 * Client Key are write-only and never diffed.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildAkeylessClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractK8sAuthConfigSpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    let live
    try {
      live = await getK8sAuthConfig(client, spec.name)
    } catch (error) {
      diffs.push({
        field: spec.name,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
      continue
    }

    if (!live) {
      diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    if (live.access_id && live.access_id !== spec.accessId) {
      diffs.push({ field: `${spec.name}.accessId`, expected: spec.accessId, actual: live.access_id, severity: 'critical' })
    }
    if ((live.k8s_host ?? '') !== spec.k8sHost) {
      diffs.push({ field: `${spec.name}.k8sHost`, expected: spec.k8sHost, actual: live.k8s_host ?? '(none)', severity: 'warning' })
    }
    if ((live.k8s_issuer ?? '') !== spec.k8sIssuer) {
      diffs.push({ field: `${spec.name}.k8sIssuer`, expected: spec.k8sIssuer, actual: live.k8s_issuer ?? '(none)', severity: 'warning' })
    }
    if ((live.cluster_api_type ?? '') !== spec.clusterApiType) {
      diffs.push({ field: `${spec.name}.clusterApiType`, expected: spec.clusterApiType, actual: live.cluster_api_type ?? '(none)', severity: 'warning' })
    }
    if ((live.k8s_auth_type ?? '') !== spec.k8sAuthType) {
      diffs.push({ field: `${spec.name}.k8sAuthType`, expected: spec.k8sAuthType, actual: live.k8s_auth_type ?? '(none)', severity: 'warning' })
    }
    const liveDisableIssValidation = boolFlag(live.disable_iss_validation)
    if (liveDisableIssValidation !== boolFlag(spec.disableIssuerValidation)) {
      diffs.push({
        field: `${spec.name}.disableIssuerValidation`,
        expected: String(spec.disableIssuerValidation),
        actual: liveDisableIssValidation,
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
