import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildQualysClient,
  qualysErrorMessage,
  qualysReturnId,
  qualysWriteError,
  xmlText,
  xmlTextList,
  type QualysClient,
  type QualysParams,
} from '../../lib/qualys'
import {
  extractSearchListSpecs,
  parseQids,
  searchListKey,
  type LiveSearchList,
  type SearchListSpec,
} from './validate'

export const SEARCH_LIST_PATH = '/api/2.0/fo/qid/search_list/static/'

export interface SearchListRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  prior?: LiveSearchList
}

/**
 * Deploy Qualys static search lists via the classic v2 API.
 *
 * Identity is the title natural key: list search lists, match on the title, then
 * update an existing list by id or create a new one. On update, the QID set is
 * replaced wholesale with the declared set (`qids`, which cannot be mixed with
 * add_qids/remove_qids).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildQualysClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, platformUrl } = built

  const specs = extractSearchListSpecs(ctx.canvas).filter((s) => s.title && parseQids(s.qids).length > 0)
  const rollbackState: SearchListRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listSearchLists(client)
    const byKey = new Map(existing.map((l) => [searchListKey(l), l]))

    for (const spec of specs) {
      const label = spec.title
      const key = searchListKey(spec)
      const live = byKey.get(key)

      if (live) {
        rollbackState.push({ key, label, existed: true, id: live.id, prior: live })
        const res = await client.post(SEARCH_LIST_PATH, buildUpdateParams(spec, live.id))
        const failed = qualysWriteError(res)
        if (failed) throw new Error(`Failed to update search list "${label}": ${failed}`)
      } else {
        const res = await client.post(SEARCH_LIST_PATH, buildCreateParams(spec))
        const failed = qualysWriteError(res)
        if (failed) throw new Error(`Failed to create search list "${label}": ${failed}`)
        const newId = qualysReturnId(res.body)
        if (!newId) throw new Error(`Search list "${label}" was created but the API returned no id`)
        rollbackState.push({ key, label, existed: false, id: newId })
        createdIds.push(newId)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} search list(s) to ${platformUrl}: ${deployed.join(', ')}`,
      artifacts: { platformUrl, deployedSearchLists: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Search list deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { platformUrl, deployedSearchLists: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all static search lists; throws on a non-OK response. */
export async function listSearchLists(client: QualysClient): Promise<LiveSearchList[]> {
  const res = await client.list(SEARCH_LIST_PATH, {}, 'STATIC_LIST')
  if (!res.ok) {
    throw new Error(`Failed to list search lists: ${qualysErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.blocks.map(parseSearchListBlock).filter((l) => l.id && l.title)
}

/** Parse one <STATIC_LIST> block into a LiveSearchList. */
export function parseSearchListBlock(block: string): LiveSearchList {
  const qidsBlock = block.match(/<QIDS>([\s\S]*?)<\/QIDS>/i)?.[1] ?? ''
  return {
    id: xmlText(block, 'ID'),
    title: xmlText(block, 'TITLE'),
    global: xmlText(block, 'GLOBAL') === '1',
    qids: xmlTextList(qidsBlock, 'QID').filter(Boolean),
    comments: xmlText(block, 'COMMENTS'),
  }
}

export function buildCreateParams(spec: SearchListSpec): QualysParams {
  return {
    action: 'create',
    title: spec.title,
    qids: parseQids(spec.qids).join(','),
    global: spec.global ? 1 : 0,
    comments: spec.comments,
  }
}

export function buildUpdateParams(spec: SearchListSpec, id: string): QualysParams {
  return {
    action: 'update',
    id,
    title: spec.title,
    qids: parseQids(spec.qids).join(','),
    global: spec.global ? 1 : 0,
    comments: spec.comments,
  }
}
