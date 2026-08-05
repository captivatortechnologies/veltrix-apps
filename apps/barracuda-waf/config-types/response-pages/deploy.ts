import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildBarracudaClient, barracudaErrorMessage } from '../../lib/barracudaWaf'
import {
  buildResponsePageBody,
  extractResponsePageSpecs,
  listResponsePages,
  responsePageKey,
  responsePagePath,
  type LiveResponsePage,
} from './validate'

export type ResponsePageRollbackEntry =
  | { action: 'created'; name: string }
  | { action: 'updated'; name: string; prior: LiveResponsePage }
  | { action: 'deleted'; name: string; prior: LiveResponsePage }

export interface ResponsePagesRollbackData {
  entries: ResponsePageRollbackEntry[]
}

/**
 * Deploy the Application's Response Pages via
 * /applications/{appName}/response_page_component/pages/.
 *
 * This config type OWNS the page set: the canvas is the complete desired
 * list, reconciled by page name. Existing pages not declared are removed;
 * declared pages not yet present are created (POST); declared pages that
 * already exist are updated (PUT) unconditionally, so any out-of-band edit is
 * corrected. Every touched page's prior state is captured for rollback.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildBarracudaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl, appName } = built

  const specs = extractResponsePageSpecs(ctx.canvas).filter((s) => s.name)
  const rollback: ResponsePageRollbackEntry[] = []
  let created = 0
  let updated = 0
  let removed = 0

  try {
    const existing = await listResponsePages(client, appName)
    const byKey = new Map(existing.filter((p) => p.name).map((p) => [responsePageKey(p.name as string), p]))
    const declaredKeys = new Set(specs.map((s) => responsePageKey(s.name)))

    for (const spec of specs) {
      const key = responsePageKey(spec.name)
      const live = byKey.get(key)
      const body = buildResponsePageBody(spec)

      if (live) {
        rollback.push({ action: 'updated', name: spec.name, prior: live })
        const res = await client.request('PUT', responsePagePath(client, appName, spec.name), { body })
        if (!res.ok) throw new Error(`Failed to update Response Page "${spec.name}": ${barracudaErrorMessage(res)}`)
        updated++
      } else {
        const res = await client.request('POST', `${client.appPath(appName)}/response_page_component/pages/`, { body })
        if (!res.ok) throw new Error(`Failed to create Response Page "${spec.name}": ${barracudaErrorMessage(res)}`)
        rollback.push({ action: 'created', name: spec.name })
        created++
      }
    }

    for (const page of existing) {
      if (!page.name || declaredKeys.has(responsePageKey(page.name))) continue
      rollback.push({ action: 'deleted', name: page.name, prior: page })
      const res = await client.request('DELETE', responsePagePath(client, appName, page.name))
      if (res.status !== 404 && !res.ok) {
        throw new Error(`Failed to remove undeclared Response Page "${page.name}": ${barracudaErrorMessage(res)}`)
      }
      removed++
    }

    return {
      success: true,
      message: `Deployed Response Pages to Application "${appName}": ${created} created, ${updated} updated, ${removed} removed.`,
      artifacts: { baseUrl, appName, created, updated, removed },
      rollbackData: { entries: rollback } satisfies ResponsePagesRollbackData,
    }
  } catch (error) {
    return {
      success: false,
      message: `Response Pages deployment failed after ${created + updated} upsert(s), ${removed} removal(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, appName, created, updated, removed },
      rollbackData: { entries: rollback } satisfies ResponsePagesRollbackData,
    }
  }
}
