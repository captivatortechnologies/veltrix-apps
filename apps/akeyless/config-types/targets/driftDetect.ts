import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildAkeylessClient, stableStringify } from '../../lib/akeyless'
import { getTargetDetails, detectLiveTargetType, mapLiveDetailsToSpec } from './deploy'
import { extractTargetSpecs, type TargetSpec } from './validate'

/** Non-secret fields compared for drift, scoped per type (write-only credential fields are never diffed). */
function relevantKeys(type: TargetSpec['type']): (keyof TargetSpec)[] {
  const common: (keyof TargetSpec)[] = ['description', 'deleteProtection']
  const byType: Record<string, (keyof TargetSpec)[]> = {
    db: ['connectionType', 'host', 'port', 'dbName', 'userName', 'ssl', 'sslCertificate', 'dbServerCertificates', 'dbServerName', 'enableMtls'],
    aws: ['accessKeyId', 'region', 'useGwCloudIdentity'],
    k8s: ['k8sClusterEndpoint', 'k8sAuthType', 'k8sClusterName', 'useGwServiceAccount'],
  }
  return [...common, ...(byType[type] ?? [])]
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildAkeylessClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractTargetSpecs(ctx.deployedConfig).filter((s) => s.name && s.type)

  for (const spec of specs) {
    let live
    try {
      live = await getTargetDetails(client, spec.name)
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

    const liveType = detectLiveTargetType(live)
    if (liveType !== 'unknown' && liveType !== spec.type) {
      diffs.push({ field: `${spec.name}.type`, expected: spec.type, actual: liveType, severity: 'critical' })
      continue
    }

    const liveSpec = mapLiveDetailsToSpec(spec, live)
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
  if (value === '' || value === undefined || value === null) return '(none)'
  return String(value)
}
