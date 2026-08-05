import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildTinesClient, tinesErrorMessage } from '../../lib/tinesApi'
import { extractFolderSpecs, findFolder, findFolderByName } from './_shared'
import { listFolders } from './deploy'

/**
 * Health check for folders configuration:
 *   1. Tines API reachability + auth (GET /api/v1/folders answers 2xx)
 *   2. every declared folder still exists in its (team, content type, parent) scope
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheck[] = []

  const built = buildTinesClient(ctx.component?.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'credential', passed: false, message: built.error }] }
  }
  const { client } = built

  const started = Date.now()
  let reachable = false
  try {
    const res = await client.request('GET', '/folders', { query: { per_page: 1 } })
    reachable = res.ok
    checks.push({
      name: 'tines_reachable',
      passed: res.ok,
      message: res.ok ? `Tines reachable (HTTP ${res.status}).` : `Tines returned HTTP ${res.status}: ${tinesErrorMessage(res)}`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'tines_reachable',
      passed: false,
      message: `Tines unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  if (reachable) {
    const specs = extractFolderSpecs(ctx.canvas).filter((s) => s.name && s.teamId && s.contentType)
    for (const spec of specs) {
      try {
        const live = await listFolders(client, spec.teamId, spec.contentType)
        const parent = spec.parentFolderName ? findFolderByName(live, spec.teamId, spec.contentType, spec.parentFolderName) : null
        const parentId = spec.parentFolderName ? (parent?.id !== undefined ? String(parent.id) : '__unresolved__') : null
        const present = Boolean(findFolder(live, spec, parentId))
        checks.push({
          name: `folder:${spec.name}`,
          passed: present,
          message: present ? `Folder "${spec.name}" is present.` : `Folder "${spec.name}" is missing.`,
        })
      } catch (error) {
        checks.push({
          name: `folder:${spec.name}`,
          passed: false,
          message: `Could not list folders: ${error instanceof Error ? error.message : 'error'}`,
        })
      }
    }
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
