import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildIntuneClient, graphErrorMessage, parseJson, type IntuneClient } from '../../lib/intune'
import { extractScopeTagSpecs, scopeTagKey, type ScopeTagSpec } from './validate'

/** Graph beta collection for role scope tags (the IntuneClient base is /beta). */
export const SCOPE_TAGS_PATH = '/deviceManagement/roleScopeTags'

const SCOPE_TAG_ODATA_TYPE = '#microsoft.graph.roleScopeTag'

/** The built-in "Default" scope tag has id "0" and cannot be created/renamed/deleted. */
export const BUILT_IN_SCOPE_TAG_ID = '0'

/** A live roleScopeTag (only the fields we read/write). */
export interface LiveScopeTag {
  id?: string
  displayName?: string
  description?: string
  isBuiltIn?: boolean
}

export interface ScopeTagRollbackEntry {
  name: string
  existed: boolean
  id?: string
  prior?: {
    displayName?: string
    description?: string
  }
}

/**
 * True when a live tag is the Intune-managed built-in tag — either it self-reports
 * isBuiltIn, or it carries the reserved built-in id "0". Such a tag is NEVER
 * created, updated or deleted by this config type.
 */
export function isBuiltInScopeTag(tag: LiveScopeTag): boolean {
  return tag.isBuiltIn === true || tag.id === BUILT_IN_SCOPE_TAG_ID
}

/** Create/update body for a scope tag. isBuiltIn/id are read-only, so they are omitted. */
export function buildScopeTagBody(spec: ScopeTagSpec): Record<string, unknown> {
  return {
    '@odata.type': SCOPE_TAG_ODATA_TYPE,
    displayName: spec.name,
    description: spec.description ?? '',
  }
}

/**
 * Deploy Intune role scope tags via the Graph beta roleScopeTags API.
 *
 * Reconciliation is by tag name (displayName). Graph does not filter these by name,
 * so the tenant collection is paged and matched client-side: PATCH an existing tag
 * by id or POST a new one. The built-in "Default" tag (isBuiltIn=true or id "0") is
 * managed by Intune — if a declared tag matches it, it is SKIPPED (never modified).
 * Non-destructive: tags not declared here are left untouched.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildIntuneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, graphHost } = built

  const specs = extractScopeTagSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: ScopeTagRollbackEntry[] = []
  const created: string[] = []
  const updated: string[] = []
  const skipped: string[] = []

  try {
    const existing = await listScopeTags(client)
    const byName = new Map(existing.filter((t) => t.displayName).map((t) => [scopeTagKey(t.displayName as string), t]))

    for (const spec of specs) {
      const live = byName.get(scopeTagKey(spec.name))

      if (live && live.id) {
        // The built-in Default tag is managed by Intune — refuse to touch it.
        if (isBuiltInScopeTag(live)) {
          skipped.push(spec.name)
          continue
        }
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: live.id,
          prior: { displayName: live.displayName, description: live.description },
        })
        const res = await client.request('PATCH', `${SCOPE_TAGS_PATH}/${live.id}`, { body: buildScopeTagBody(spec) })
        if (!res.ok) throw new Error(`Failed to update scope tag "${spec.name}": ${graphErrorMessage(res)}`)
        updated.push(spec.name)
      } else {
        const res = await client.request('POST', SCOPE_TAGS_PATH, { body: buildScopeTagBody(spec) })
        if (!res.ok) throw new Error(`Failed to create scope tag "${spec.name}": ${graphErrorMessage(res)}`)
        const createdTag = parseJson<{ id?: string }>(res.body)
        rollbackState.push({ name: spec.name, existed: false, id: createdTag?.id })
        created.push(spec.name)
      }
    }

    const parts = [`${created.length} created`, `${updated.length} updated`]
    if (skipped.length > 0) parts.push(`${skipped.length} skipped (built-in, managed by Intune)`)
    return {
      success: true,
      message: `Role scope tags deployed to ${graphHost}: ${parts.join(', ')}`,
      artifacts: { graphHost, created, updated, skipped },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Role scope tag deployment failed after ${created.length + updated.length} of ${specs.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { graphHost, created, updated, skipped },
      rollbackData: { previousState: rollbackState },
    }
  }
}

/** List the tenant's role scope tags (paged); throws on a non-OK response. */
export async function listScopeTags(client: IntuneClient): Promise<LiveScopeTag[]> {
  const res = await client.getAll<LiveScopeTag>(SCOPE_TAGS_PATH)
  if (!res.ok) {
    throw new Error(`Failed to list role scope tags: ${graphErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}
