import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildQualysClient,
  qualysErrorMessage,
  qualysReturnId,
  qualysWriteError,
  xmlText,
  type QualysClient,
  type QualysParams,
} from '../../lib/qualys'
import { flattenScalarParams, parseFlatScalarObject } from '../lib/qualysJson'
import {
  dynamicListKey,
  extractDynamicListSpecs,
  type DynamicListSpec,
  type LiveDynamicList,
} from './validate'

export const DYNAMIC_LIST_PATH = '/api/2.0/fo/qid/search_list/dynamic/'

export interface DynamicListRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  prior?: LiveDynamicList
}

/**
 * Deploy Qualys dynamic search lists via the classic v2 API.
 *
 * Identity is the title natural key: list dynamic search lists, match on the
 * title, then update an existing list by id or create a new one. Title, global
 * and comments are reconciled from first-class fields; every other criteria
 * parameter comes from the flat criteria JSON.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildQualysClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, platformUrl } = built

  const specs = extractDynamicListSpecs(ctx.canvas).filter(
    (s) => s.title && !parseFlatScalarObject(s.criteriaJson).error,
  )
  const rollbackState: DynamicListRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listDynamicLists(client)
    const byKey = new Map(existing.map((l) => [dynamicListKey(l), l]))

    for (const spec of specs) {
      const label = spec.title
      const key = dynamicListKey(spec)
      const live = byKey.get(key)

      if (live) {
        rollbackState.push({ key, label, existed: true, id: live.id, prior: live })
        const res = await client.post(DYNAMIC_LIST_PATH, buildUpdateParams(spec, live.id))
        const failed = qualysWriteError(res)
        if (failed) throw new Error(`Failed to update dynamic search list "${label}": ${failed}`)
      } else {
        const res = await client.post(DYNAMIC_LIST_PATH, buildCreateParams(spec))
        const failed = qualysWriteError(res)
        if (failed) throw new Error(`Failed to create dynamic search list "${label}": ${failed}`)
        const newId = qualysReturnId(res.body)
        if (!newId) throw new Error(`Dynamic search list "${label}" was created but the API returned no id`)
        rollbackState.push({ key, label, existed: false, id: newId })
        createdIds.push(newId)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} dynamic search list(s) to ${platformUrl}: ${deployed.join(', ')}`,
      artifacts: { platformUrl, deployedDynamicLists: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Dynamic search list deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { platformUrl, deployedDynamicLists: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all dynamic search lists; throws on a non-OK response. */
export async function listDynamicLists(client: QualysClient): Promise<LiveDynamicList[]> {
  const res = await client.list(DYNAMIC_LIST_PATH, {}, 'DYNAMIC_LIST')
  if (!res.ok) {
    throw new Error(
      `Failed to list dynamic search lists: ${qualysErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.blocks.map(parseDynamicListBlock).filter((l) => l.id && l.title)
}

/** Parse one <DYNAMIC_LIST> block into a LiveDynamicList. */
export function parseDynamicListBlock(block: string): LiveDynamicList {
  return {
    id: xmlText(block, 'ID'),
    title: xmlText(block, 'TITLE'),
    global: parseGlobalFlag(xmlText(block, 'GLOBAL')),
    comments: xmlText(block, 'COMMENTS'),
  }
}

/** The list output renders GLOBAL as "Yes"/"No"; create/update take {0|1}. */
export function parseGlobalFlag(value: string): boolean {
  const v = value.trim().toLowerCase()
  return v === 'yes' || v === '1' || v === 'true'
}

/** Build the shared create/update params from a spec (excludes action/id). */
export function dynamicListParams(spec: DynamicListSpec): QualysParams {
  const criteria = parseFlatScalarObject(spec.criteriaJson).value ?? {}
  // First-class fields win over any collision in the criteria JSON.
  const params: QualysParams = { ...flattenScalarParams(criteria) }
  params.title = spec.title
  params.global = spec.global ? 1 : 0
  if (spec.comments) params.comments = spec.comments
  return params
}

export function buildCreateParams(spec: DynamicListSpec): QualysParams {
  return { action: 'create', ...dynamicListParams(spec) }
}

export function buildUpdateParams(spec: DynamicListSpec, id: string): QualysParams {
  return { action: 'update', id, ...dynamicListParams(spec) }
}
