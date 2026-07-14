import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSplunkUrl, buildAuthHeader } from '../../lib/splunkApi'
import { parseConf } from '../../lib/splunkConf'

interface FileEntry {
  path?: string
  content?: string
}

/**
 * Detect drift between the deployed config-file stanzas and the live values on
 * the Splunk instance.
 *   missing stanza ............ critical
 *   attribute value changed ... warning
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, deployedConfig } = ctx
  const diffs: DriftDiff[] = []

  if (!credential || !connectivity) return { hasDrift: false, diffs: [] }

  const baseUrl = buildSplunkUrl(component, connectivity)
  const auth = buildAuthHeader(credential)

  for (const section of deployedConfig.sections) {
    const targetApp = ((section.fields.targetApp as string | undefined) ?? 'system').trim() || 'system'
    const files = Array.isArray(section.fields.files) ? (section.fields.files as FileEntry[]) : []

    for (const file of files) {
      const path = typeof file?.path === 'string' ? file.path.trim() : ''
      if (!path) continue
      const slash = path.indexOf('/')
      const folder = slash === -1 ? 'default' : path.slice(0, slash)
      const filename = slash === -1 ? path : path.slice(slash + 1)
      if (!((folder === 'default' || folder === 'local') && filename.endsWith('.conf'))) continue
      const confName = filename.slice(0, -'.conf'.length)
      const nsBase = `/servicesNS/nobody/${encodeURIComponent(targetApp)}/configs/conf-${encodeURIComponent(confName)}`

      for (const stanza of parseConf(file.content ?? '')) {
        const label = `${targetApp}:${confName}[${stanza.name}]`
        try {
          const res = await fetch(`${baseUrl}${nsBase}/${encodeURIComponent(stanza.name)}?output_mode=json`, {
            method: 'GET', headers: auth, signal: AbortSignal.timeout(15_000),
          })
          if (!res.ok) {
            if (res.status === 404) diffs.push({ field: label, expected: 'present', actual: 'missing', severity: 'critical' })
            continue
          }
          const data = JSON.parse(await res.text())
          const actual = data?.entry?.[0]?.content || {}
          for (const [key, expected] of Object.entries(stanza.settings)) {
            const actualValue = actual[key] === undefined ? '' : String(actual[key])
            if (actualValue !== expected) {
              diffs.push({ field: `${label}.${key}`, expected, actual: actualValue, severity: 'warning' })
            }
          }
        } catch (error) {
          diffs.push({
            field: label,
            expected: 'reachable',
            actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
            severity: 'critical',
          })
        }
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
