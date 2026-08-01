import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildSecretServerClient, secretServerErrorMessage } from '../../lib/secretServerApi'
import { extractFolderSpecs, searchFolders, resolveParentFolderId, findFolderByNameAndParent } from './_shared'

/**
 * Health for folders config:
 *   1. Secret Server reachability + OAuth2 logon (GET /api/v1/folders?take=1)
 *   2. Every declared folder (by name within its parent) still exists
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheck[] = []

  const built = buildSecretServerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'credential', passed: false, message: built.error }] }
  }
  const { client, apiBase } = built

  const started = Date.now()
  let reachable = false
  try {
    const res = await client.request('GET', '/folders', { query: { take: 1 } })
    reachable = res.ok
    checks.push({
      name: 'secretserver_reachable',
      passed: res.ok,
      message: res.ok ? `Secret Server reachable at ${apiBase}` : `Secret Server returned HTTP ${res.status}: ${secretServerErrorMessage(res)}`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'secretserver_reachable',
      passed: false,
      message: `Secret Server unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  if (reachable) {
    const specs = extractFolderSpecs(ctx.canvas.items ?? ctx.canvas.sections ?? []).filter((s) => s.folderName)
    for (const spec of specs) {
      try {
        const parent = await resolveParentFolderId(client, spec.parentFolderName)
        if (parent.id === null) {
          checks.push({ name: `folder:${spec.folderName}`, passed: false, message: parent.error ?? 'parent folder not found' })
          continue
        }
        const siblings = await searchFolders(client, spec.folderName)
        const present = findFolderByNameAndParent(siblings, spec.folderName, parent.id) !== null
        checks.push({
          name: `folder:${spec.folderName}`,
          passed: present,
          message: present ? `Folder "${spec.folderName}" is present` : `Folder "${spec.folderName}" is missing`,
        })
      } catch (error) {
        checks.push({ name: `folder:${spec.folderName}`, passed: false, message: error instanceof Error ? error.message : 'check failed' })
      }
    }
  }

  const passed = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passed / checks.length) * 100) : 0
  return { healthy: passed === checks.length, score, checks }
}
