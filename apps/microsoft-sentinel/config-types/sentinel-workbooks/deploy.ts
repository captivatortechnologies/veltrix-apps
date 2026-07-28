import { randomUUID } from 'node:crypto'
import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildSentinelClient,
  armErrorMessage,
  parseJson,
  WORKSPACE_API_VERSION,
  type SentinelClient,
} from '../../lib/sentinel'
import {
  extractWorkbookSpecs,
  workbookKey,
  WORKBOOKS_API_VERSION,
  WORKBOOK_CATEGORY,
  WORKBOOK_KIND,
  WORKBOOK_VERSION,
  type WorkbookSpec,
} from './validate'

/** A live Microsoft.Insights workbook (only the fields we read). */
export interface LiveWorkbook {
  /** Full ARM resource id (correlation key for drift attribution). */
  id?: string
  /** The ARM resource name — a server-assigned GUID. */
  name?: string
  location?: string
  properties?: {
    displayName?: string
    serializedData?: string
    category?: string
    sourceId?: string
    version?: string
  }
}

/** State captured per workbook so a rollback can delete creates and restore updates. */
export interface WorkbookRollbackEntry {
  displayName: string
  /** The ARM resource name (GUID) this deploy wrote to — reused by rollback. */
  guid: string
  existed: boolean
  /** Prior content captured before an update, so rollback can restore it verbatim. */
  prior?: { displayName?: string; serializedData?: string; version?: string }
}

/** Only the client surface the path/read helpers depend on (keeps unit tests small). */
type WorkspaceScopedClient = Pick<SentinelClient, 'workspacePath'>
type WorkbookReadClient = Pick<SentinelClient, 'workspacePath' | 'getAll'>
type WorkbookLocationClient = Pick<SentinelClient, 'workspacePath' | 'request'>

/**
 * The resource-group ARM scope, derived from the workspace path. Workbooks live
 * under Microsoft.Insights scoped to the RESOURCE GROUP (not the workspace), and
 * the SentinelClient only builds Microsoft.OperationalInsights/SecurityInsights
 * paths — so strip the workspace's provider suffix to recover
 * /subscriptions/{sub}/resourceGroups/{rg}.
 */
export function resourceGroupScope(client: WorkspaceScopedClient): string {
  return client.workspacePath().split('/providers/')[0]
}

/** The Microsoft.Insights workbooks collection path in the workspace's resource group. */
export function workbooksCollectionPath(client: WorkspaceScopedClient): string {
  return `${resourceGroupScope(client)}/providers/Microsoft.Insights/workbooks`
}

/** The Microsoft.Insights workbook resource path for a given GUID (the ARM resource name). */
export function workbookResourcePath(client: WorkspaceScopedClient, guid: string): string {
  return `${workbooksCollectionPath(client)}/${guid}`
}

/** sourceId = the full workspace ARM resource id the workbook is linked to. */
export function workspaceSourceId(client: WorkspaceScopedClient): string {
  return client.workspacePath()
}

/**
 * List the resource group's Sentinel-category workbooks. `category` is REQUIRED by
 * the list API; `canFetchContent=true` is needed so serializedData is returned
 * (for reconcile/drift). Results are filtered to THIS workspace client-side.
 */
export async function listSentinelWorkbooks(client: WorkbookReadClient, fetchContent = true): Promise<LiveWorkbook[]> {
  const query = new URLSearchParams({ category: WORKBOOK_CATEGORY })
  if (fetchContent) query.set('canFetchContent', 'true')
  const path = `${workbooksCollectionPath(client)}?${query.toString()}`
  const res = await client.getAll<LiveWorkbook>(path, WORKBOOKS_API_VERSION)
  if (!res.ok) {
    throw new Error(res.body ? res.body.slice(0, 300) : `HTTP ${res.status}`)
  }
  return res.items
}

/**
 * Reconcile a declared workbook to a live one by display name, scoped to Sentinel
 * workbooks linked to THIS workspace (category + sourceId). The live resource
 * name is a server GUID, so display name + sourceId is the only stable key.
 */
export function findWorkbookByDisplayName(
  live: LiveWorkbook[],
  displayName: string,
  sourceId: string,
): LiveWorkbook | undefined {
  const wantName = workbookKey(displayName)
  const wantSource = sourceId.trim().toLowerCase()
  return live.find((w) => {
    const props = w.properties ?? {}
    const isSentinel = (props.category ?? '').trim().toLowerCase() === WORKBOOK_CATEGORY
    const sameSource = (props.sourceId ?? '').trim().toLowerCase() === wantSource
    const sameName = workbookKey(props.displayName ?? '') === wantName
    return isSentinel && sameSource && sameName
  })
}

/**
 * The Microsoft.Insights workbook request body for a spec. `kind:shared` +
 * `location` (the workspace region) are top-level; displayName/serializedData/
 * category/sourceId/version live under properties. serializedData is the entire
 * workbook JSON as an opaque string.
 */
export function buildWorkbookBody(
  spec: Pick<WorkbookSpec, 'displayName' | 'serializedData'>,
  location: string,
  sourceId: string,
  version: string = WORKBOOK_VERSION,
): unknown {
  return {
    kind: WORKBOOK_KIND,
    location,
    properties: {
      displayName: spec.displayName,
      serializedData: spec.serializedData,
      category: WORKBOOK_CATEGORY,
      sourceId,
      version: version || WORKBOOK_VERSION,
    },
  }
}

/**
 * Resolve the workspace region (the required workbook `location`) by reading the
 * Log Analytics workspace resource — there is no region app-setting, so it is
 * derived from the live workspace. Throws with a clear message when unavailable.
 */
export async function resolveWorkspaceLocation(client: WorkbookLocationClient): Promise<string> {
  const res = await client.request('GET', client.workspacePath(), { apiVersion: WORKSPACE_API_VERSION })
  if (!res.ok) throw new Error(`Failed to read workspace region: ${armErrorMessage(res)}`)
  const parsed = parseJson<{ location?: string }>(res.body)
  const location = parsed?.location?.trim()
  if (!location) throw new Error('Workspace region (location) is unavailable — it is required to create workbooks')
  return location
}

/**
 * Deploy workbooks via ARM (Microsoft.Insights/workbooks scoped to the resource
 * group). Reconciliation is by display name among the workspace's Sentinel-category
 * workbooks: a match reuses its server GUID (update), otherwise a fresh GUID is
 * minted (create). Every workbook is a PUT with the workspace region as `location`
 * and the workspace resource id as `sourceId`. Workbooks not declared here are
 * left untouched.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildSentinelClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, armHost } = built

  const specs = extractWorkbookSpecs(ctx.canvas).filter((s) => s.displayName)
  const rollbackState: WorkbookRollbackEntry[] = []
  const created: string[] = []
  const updated: string[] = []

  if (specs.length === 0) {
    return {
      success: true,
      message: `No workbooks to deploy to ${armHost}`,
      artifacts: { armHost, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  }

  try {
    const sourceId = workspaceSourceId(client)
    const location = await resolveWorkspaceLocation(client)
    const live = await listSentinelWorkbooks(client, true)

    for (const spec of specs) {
      const match = findWorkbookByDisplayName(live, spec.displayName, sourceId)
      let existed = false
      let guid: string
      if (match?.name) {
        existed = true
        guid = match.name
        rollbackState.push({
          displayName: spec.displayName,
          guid,
          existed: true,
          prior: {
            displayName: match.properties?.displayName,
            serializedData: match.properties?.serializedData,
            version: match.properties?.version,
          },
        })
      } else {
        guid = randomUUID()
        rollbackState.push({ displayName: spec.displayName, guid, existed: false })
      }

      const res = await client.request('PUT', workbookResourcePath(client, guid), {
        apiVersion: WORKBOOKS_API_VERSION,
        body: buildWorkbookBody(spec, location, sourceId),
      })
      if (!res.ok) throw new Error(`Failed to ${existed ? 'update' : 'create'} workbook "${spec.displayName}": ${armErrorMessage(res)}`)

      ;(existed ? updated : created).push(spec.displayName)
    }

    return {
      success: true,
      message: `Workbooks deployed to ${armHost}: ${created.length} created, ${updated.length} updated`,
      artifacts: { armHost, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Workbook deployment failed after ${created.length + updated.length} of ${specs.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { armHost, created, updated },
      rollbackData: { previousState: rollbackState },
    }
  }
}
