import type { DriftContext, DriftResult, DriftDiff } from '../../../../core/pipeline-engine/types'

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, deployedConfig } = ctx
  const diffs: DriftDiff[] = []

  if (!credential || !connectivity) return { hasDrift: false, diffs: [] }

  const baseUrl = buildSplunkUrl(component, connectivity)
  const auth = buildAuthHeader(credential)

  for (const section of deployedConfig.sections) {
    const roleName = section.fields.name as string
    if (!roleName) continue

    try {
      const res = await fetch(`${baseUrl}/services/authorization/roles/${roleName}?output_mode=json`, {
        method: 'GET', headers: auth, signal: AbortSignal.timeout(15_000),
      })

      if (!res.ok) {
        if (res.status === 404) {
          diffs.push({ field: roleName, expected: 'exists', actual: 'missing', severity: 'critical' })
        }
        continue
      }

      const data = JSON.parse(await res.text())
      const actual = data?.entry?.[0]?.content || {}

      // Compare capabilities
      const expectedCaps = (section.fields.capabilities as string[] || []).sort()
      const actualCaps = (actual.capabilities as string[] || []).sort()
      if (JSON.stringify(expectedCaps) !== JSON.stringify(actualCaps)) {
        const missing = expectedCaps.filter((c: string) => !actualCaps.includes(c))
        const extra = actualCaps.filter((c: string) => !expectedCaps.includes(c))
        if (missing.length > 0 || extra.length > 0) {
          diffs.push({
            field: `${roleName}.capabilities`,
            expected: expectedCaps,
            actual: actualCaps,
            severity: missing.length > 0 ? 'warning' : 'info',
          })
        }
      }

      // Compare search filter
      if (section.fields.srchFilter) {
        const expectedFilter = section.fields.srchFilter as string
        const actualFilter = actual.srchFilter as string || ''
        if (expectedFilter !== actualFilter) {
          diffs.push({ field: `${roleName}.srchFilter`, expected: expectedFilter, actual: actualFilter, severity: 'warning' })
        }
      }

      // Compare imported roles
      const expectedImports = (section.fields.importedRoles as string[] || []).sort()
      const actualImports = (actual.imported_roles as string[] || []).sort()
      if (JSON.stringify(expectedImports) !== JSON.stringify(actualImports)) {
        diffs.push({ field: `${roleName}.importedRoles`, expected: expectedImports, actual: actualImports, severity: 'warning' })
      }
    } catch (error) {
      diffs.push({ field: roleName, expected: 'reachable', actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`, severity: 'critical' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

function buildSplunkUrl(component: DriftContext['component'], connectivity: NonNullable<DriftContext['connectivity']>): string {
  if (connectivity.httpsUrl) return connectivity.httpsUrl
  if (connectivity.tailscaleDeviceIP) return `https://${connectivity.tailscaleDeviceIP}:${component.port || '8089'}`
  return `https://${component.hostname}:${component.port || '8089'}`
}

function buildAuthHeader(credential: NonNullable<DriftContext['credential']>): Record<string, string> {
  if (credential.apiToken) return { Authorization: `Bearer ${credential.apiToken}` }
  return { Authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString('base64')}` }
}
