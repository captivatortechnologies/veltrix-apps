import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOneLoginClient, parseJson, oneLoginErrorMessage, type OneLoginClient } from '../../lib/oneLogin'
import { extractAppSpecs, parseJsonObject, type AppSpec, type LiveApp } from './validate'

/** The full writable surface of an app - everything create/update accepts. */
export interface AppWriteInput {
  /** Only sent on create - OneLogin has no documented way to re-base an existing app onto a new connector. */
  connectorId?: number
  name: string
  description: string
  notes: string
  visible: boolean
  allowAssumedSignin: boolean
  policyId: number | null
  tabId: number | null
  provisioningEnabled: boolean
  /** Present only when this app manages it (declared in the canvas, or captured from a live object for rollback). */
  configuration?: Record<string, unknown>
  parameters?: Record<string, unknown>
}

export interface AppRollbackEntry {
  name: string
  existed: boolean
  id?: number
  /** Prior writable state, captured before an update so rollback can PUT it back. */
  prior?: AppWriteInput
}

/**
 * Deploy OneLogin apps via the Apps API.
 *
 * ONE item = ONE app, matched on NAME (OneLogin has no upsert):
 *   - list GET  /api/2/apps           (client.getAll, Link-header paginated)
 *   - PUT       /api/2/apps/{id}      - partial update ("This API supports
 *     partial updates or patching of app configuration" per OneLogin's own
 *     docs) - only the keys in the request body change; `configuration`/
 *     `parameters` are therefore OMITTED entirely when the canvas leaves
 *     them blank, so an existing app's connector-specific config/parameters
 *     are left untouched rather than wiped.
 *   - POST      /api/2/apps           - create a missing one (capture the new id)
 *
 * Never deletes an app absent from this canvas - rollback only reverts what
 * THIS deploy created or changed.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOneLoginClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, domain } = built

  const specs = extractAppSpecs(ctx.canvas).filter((s) => s.name && s.connectorId !== undefined)
  const rollbackState: AppRollbackEntry[] = []
  const createdIds: number[] = []
  const deployed: string[] = []

  try {
    const apps = await listApps(client)

    for (const spec of specs) {
      const input = specToWriteInput(spec)
      const existing = apps.find((a) => a.name === spec.name) ?? null

      if (existing?.id) {
        rollbackState.push({
          name: spec.name,
          existed: true,
          id: existing.id,
          prior: liveAppToWriteInput(existing),
        })

        const res = await client.request('PUT', `/api/2/apps/${existing.id}`, { body: buildAppBody(input) })
        if (!res.ok) {
          throw new Error(`Failed to update app "${spec.name}": ${oneLoginErrorMessage(res)}`)
        }
      } else {
        const res = await client.request('POST', '/api/2/apps', {
          body: buildAppBody({ ...input, connectorId: spec.connectorId }),
        })
        if (!res.ok) {
          throw new Error(`Failed to create app "${spec.name}": ${oneLoginErrorMessage(res)}`)
        }
        const created = parseJson<LiveApp>(res.body)
        if (!created?.id) {
          throw new Error(`App "${spec.name}" was created but the API returned no id`)
        }
        createdIds.push(created.id)
        rollbackState.push({ name: spec.name, existed: false, id: created.id })
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} app(s) to OneLogin account ${domain}: ${deployed.join(', ')}`,
      artifacts: { domain, deployedApps: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `App deployment failed after ${deployed.length} of ${specs.length} app(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { domain, deployedApps: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ------------------------------------------------------------------

/** List every app in the account, following Link-header pagination. */
export async function listApps(client: OneLoginClient): Promise<LiveApp[]> {
  const res = await client.getAll<LiveApp>('/api/2/apps')
  if (!res.ok) {
    throw new Error(`Failed to list apps: ${oneLoginErrorMessage({ status: res.status, ok: res.ok, body: res.body, linkHeader: null })}`)
  }
  return res.items
}

function specToWriteInput(spec: AppSpec): AppWriteInput {
  return {
    name: spec.name,
    description: spec.description ?? '',
    notes: spec.notes ?? '',
    visible: spec.visible,
    allowAssumedSignin: spec.allowAssumedSignin,
    policyId: spec.policyId ?? null,
    tabId: spec.tabId ?? null,
    provisioningEnabled: spec.provisioningEnabled,
    configuration: spec.configurationJson ? (parseJsonObject(spec.configurationJson) ?? undefined) : undefined,
    parameters: spec.parametersJson ? (parseJsonObject(spec.parametersJson) ?? undefined) : undefined,
  }
}

/** Capture a live app's writable fields - used both for rollback and as the base of a prior-state PUT. */
export function liveAppToWriteInput(existing: LiveApp): AppWriteInput {
  return {
    name: existing.name ?? '',
    description: typeof existing.description === 'string' ? existing.description : '',
    notes: typeof existing.notes === 'string' ? existing.notes : '',
    visible: existing.visible ?? true,
    allowAssumedSignin: existing.allow_assumed_signin ?? false,
    policyId: existing.policy_id ?? null,
    tabId: existing.tab_id ?? null,
    provisioningEnabled: existing.provisioning?.enabled ?? false,
    configuration: existing.configuration ?? {},
    parameters: existing.parameters ?? {},
  }
}

/** Build the create/update request body from a writable-fields input. */
export function buildAppBody(input: AppWriteInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: input.name,
    description: input.description,
    notes: input.notes,
    visible: input.visible,
    allow_assumed_signin: input.allowAssumedSignin,
    policy_id: input.policyId,
    tab_id: input.tabId,
    provisioning: { enabled: input.provisioningEnabled },
  }
  if (input.connectorId !== undefined) body.connector_id = input.connectorId
  if (input.configuration !== undefined) body.configuration = input.configuration
  if (input.parameters !== undefined) body.parameters = input.parameters
  return body
}
