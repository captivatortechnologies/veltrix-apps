import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildAkeylessClient, stableStringify } from '../../lib/akeyless'
import { getDynamicSecret, detectLiveType, mapLiveToSpec } from './deploy'
import { extractDynamicSecretSpecs, type DynamicSecretSpec } from './validate'

/** Non-secret fields compared for drift, scoped per type (admin credentials are never diffed). */
function relevantKeys(type: DynamicSecretSpec['type']): (keyof DynamicSecretSpec)[] {
  const common: (keyof DynamicSecretSpec)[] = ['description', 'deleteProtection', 'userTtl']
  const byType: Record<string, (keyof DynamicSecretSpec)[]> = {
    postgresql: ['postgresqlHost', 'postgresqlPort', 'postgresqlDbName', 'postgresqlUsername', 'ssl', 'creationStatements', 'revocationStatements'],
    aws: ['accessMode', 'awsAccessKeyId', 'region', 'awsUserPolicies', 'awsUserGroups', 'awsRoleArns', 'awsExternalId', 'enableAdminRotation', 'adminRotationIntervalDays'],
    k8s: ['k8sClusterEndpoint', 'k8sClusterName', 'k8sNamespace', 'k8sServiceAccount', 'useGwServiceAccount'],
  }
  return [...common, ...(byType[type] ?? [])]
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildAkeylessClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractDynamicSecretSpecs(ctx.deployedConfig).filter((s) => s.name && s.type)

  for (const spec of specs) {
    let live
    try {
      live = await getDynamicSecret(client, spec.name)
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

    const liveType = detectLiveType(live)
    if (liveType !== 'unknown' && liveType !== spec.type) {
      diffs.push({ field: `${spec.name}.type`, expected: spec.type, actual: liveType, severity: 'critical' })
      continue
    }

    const liveSpec = mapLiveToSpec(spec, live)
    for (const key of relevantKeys(spec.type)) {
      const expected = stableStringify(spec[key])
      const actual = stableStringify(liveSpec[key])
      if (expected !== actual) {
        diffs.push({
          field: `${spec.name}.${key}`,
          expected: describeValue(spec[key]),
          actual: describeValue(liveSpec[key]),
          severity: 'warning',
        })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return value.length ? value.join(', ') : '(none)'
  if (value === '' || value === undefined || value === null) return '(none)'
  return String(value)
}
