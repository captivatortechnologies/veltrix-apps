import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildSplunkUrl, buildAuthHeader } from '../../lib/splunkApi'
import { parseConf } from '../../lib/splunkConf'

interface FileEntry {
  path?: string
  content?: string
}

/**
 * Health check for a Config File Set: verify the instance is reachable and that
 * every declared stanza exists in the target app's namespace.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { component, credential, connectivity, canvas } = ctx
  const checks: HealthCheckResult['checks'] = []

  if (!credential || !connectivity) {
    return { healthy: false, score: 0, checks: [{ name: 'connectivity', passed: false, message: 'Missing credential or connectivity' }] }
  }

  const baseUrl = buildSplunkUrl(component, connectivity)
  const auth = buildAuthHeader(credential)

  checks.push(await timedCheck('server_reachable', async () => {
    const res = await fetch(`${baseUrl}/services/server/info?output_mode=json`, { method: 'GET', headers: auth, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`Server returned ${res.status}`)
    return 'Splunk instance is reachable'
  }))

  checks.push(await timedCheck('stanzas_present', async () => {
    const missing: string[] = []
    let expected = 0
    for (const section of canvas.sections) {
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
          expected += 1
          const res = await fetch(`${baseUrl}${nsBase}/${encodeURIComponent(stanza.name)}?output_mode=json`, {
            method: 'GET', headers: auth, signal: AbortSignal.timeout(10_000),
          })
          if (!res.ok) missing.push(`${targetApp}:${confName} [${stanza.name}]`)
        }
      }
    }
    if (expected === 0) return 'No stanzas declared'
    if (missing.length > 0) throw new Error(`Missing stanza(s): ${missing.join(', ')}`)
    return `All ${expected} declared stanza(s) exist`
  }))

  const passedCount = checks.filter((c) => c.passed).length
  return { healthy: passedCount === checks.length, score: Math.round((passedCount / checks.length) * 100), checks }
}

async function timedCheck(name: string, fn: () => Promise<string>): Promise<HealthCheckResult['checks'][0]> {
  const start = Date.now()
  try {
    const message = await fn()
    return { name, passed: true, message, latencyMs: Date.now() - start }
  } catch (error) {
    return { name, passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start }
  }
}
