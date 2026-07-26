import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildXsoarClient, parseJsonValue, xsoarErrorMessage, type XsoarClient } from '../../lib/xsoar'
import {
  extractIntegrationInstanceSpecs,
  SECRET_PARAM_TYPES,
  type IntegrationInstanceSpec,
  type IntegrationSearchResult,
  type LiveIntegrationConfiguration,
  type LiveIntegrationInstance,
  type LiveIntegrationParam,
} from './validate'

/** XSOAR content-version convention: 0 creates a new item, -1 overrides on update. */
const NEW_INSTANCE_VERSION = 0
const OVERRIDE_VERSION = -1

export interface IntegrationInstanceRollbackEntry {
  name: string
  existed: boolean
  /** Server id (needed to delete a created instance / restore an updated one). */
  id?: string
  prior?: LiveIntegrationInstance
}

/**
 * Deploy XSOAR integration instances via the server REST API.
 *
 * Identity is the instance NAME. Search every instance
 * (POST /settings/integration/search), match on name, then upsert with
 * PUT /settings/integration. A new instance is built from the integration's
 * module configuration (its parameter definitions), so declared parameter values
 * are placed onto the correct fields; an existing instance is updated in place,
 * overriding only the declared parameter values (encrypted parameters are left
 * untouched, per XSOAR). A created instance's server id is resolved so it can be
 * removed with DELETE /settings/integration/{id} on rollback.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildXsoarClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, serverUrl } = built

  const specs = extractIntegrationInstanceSpecs(ctx.canvas).filter((s) => s.name && s.brand)
  const rollbackState: IntegrationInstanceRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const search = await searchIntegrations(client)
    const byName = new Map(
      (search.instances ?? []).filter((i) => i.name).map((i) => [i.name as string, i]),
    )
    const configByBrand = new Map<string, LiveIntegrationConfiguration>()
    for (const config of search.configurations ?? []) {
      if (config.name) configByBrand.set(config.name, config)
    }

    for (const spec of specs) {
      const live = byName.get(spec.name)

      if (live) {
        rollbackState.push({ name: spec.name, existed: true, id: live.id, prior: live })
        await saveIntegrationInstance(client, spec, live, null)
      } else {
        const moduleConfig = configByBrand.get(spec.brand)
        if (!moduleConfig) {
          throw new Error(
            `Integration "${spec.brand}" is not installed on the server — install it before creating instance "${spec.name}"`,
          )
        }
        const created = await saveIntegrationInstance(client, spec, null, moduleConfig)
        const id = created?.id ?? (await resolveInstanceId(client, spec.name))
        rollbackState.push({ name: spec.name, existed: false, id })
        if (id) createdIds.push(id)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} integration instance(s) to ${serverUrl}: ${deployed.join(', ')}`,
      artifacts: { serverUrl, deployedInstances: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Integration instance deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { serverUrl, deployedInstances: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** Search every integration; returns the `{ instances, configurations }` envelope. Throws on non-OK. */
export async function searchIntegrations(client: XsoarClient): Promise<IntegrationSearchResult> {
  const res = await client.request('POST', '/settings/integration/search', { body: { size: 500 } })
  if (!res.ok) throw new Error(`Failed to search integrations: ${xsoarErrorMessage(res)}`)
  const value = parseJsonValue<IntegrationSearchResult>(res.body).value
  return value && typeof value === 'object' ? value : {}
}

/** List just the integration instances (used by health + drift). */
export async function listIntegrationInstances(client: XsoarClient): Promise<LiveIntegrationInstance[]> {
  const search = await searchIntegrations(client)
  return Array.isArray(search.instances) ? search.instances : []
}

/** Resolve an instance's server id by name (used right after a create). */
async function resolveInstanceId(client: XsoarClient, name: string): Promise<string | undefined> {
  const instances = await listIntegrationInstances(client)
  return instances.find((i) => i.name === name)?.id
}

/**
 * Upsert one integration instance via PUT /settings/integration.
 *
 * On update, the live instance is the base: its declared parameter values are
 * overridden (encrypted/secret params are left untouched — XSOAR does not accept
 * re-writing them here), enabled/mapper fields are applied, and the write is sent
 * with the override version. On create, the instance body is built from the
 * integration's module configuration so parameter values land on the right
 * fields. Returns the saved instance (with its server id).
 */
export async function saveIntegrationInstance(
  client: XsoarClient,
  spec: IntegrationInstanceSpec,
  live: LiveIntegrationInstance | null,
  moduleConfig: LiveIntegrationConfiguration | null,
): Promise<LiveIntegrationInstance | null> {
  const body: Record<string, unknown> = live
    ? buildUpdateBody(spec, live)
    : buildCreateBody(spec, moduleConfig)

  const res = await client.request('PUT', '/settings/integration', { body })
  if (!res.ok) throw new Error(`Failed to save integration instance "${spec.name}": ${xsoarErrorMessage(res)}`)
  return parseJsonValue<LiveIntegrationInstance>(res.body).value
}

/** Body for updating an existing instance in place (override version). */
function buildUpdateBody(
  spec: IntegrationInstanceSpec,
  live: LiveIntegrationInstance,
): Record<string, unknown> {
  const data = (live.data ?? []).map((param) => ({ ...param }))
  applyParamValues(data, spec.parameters, { skipSecrets: true })

  const body: Record<string, unknown> = { ...live, data }
  body.enabled = String(spec.enabled)
  if (spec.mappingId !== undefined) body.mappingId = spec.mappingId
  if (spec.incomingMapperId !== undefined) body.incomingMapperId = spec.incomingMapperId
  if (spec.outgoingMapperId !== undefined) body.outgoingMapperId = spec.outgoingMapperId
  body.version = OVERRIDE_VERSION
  return body
}

/** Body for creating a new instance from the integration's module configuration. */
function buildCreateBody(
  spec: IntegrationInstanceSpec,
  moduleConfig: LiveIntegrationConfiguration | null,
): Record<string, unknown> {
  const defs = (moduleConfig?.configuration ?? []).map((param) => ({ ...param }))
  applyParamValues(defs, spec.parameters, { skipSecrets: false })

  return {
    name: spec.name,
    brand: spec.brand,
    category: moduleConfig?.category ?? '',
    canSample: true,
    configuration: moduleConfig ?? {},
    data: defs,
    enabled: String(spec.enabled),
    engine: '',
    id: '',
    isIntegrationScript: true,
    passwordProtected: false,
    version: NEW_INSTANCE_VERSION,
    mappingId: spec.mappingId ?? moduleConfig?.defaultClassifier ?? '',
    incomingMapperId: spec.incomingMapperId ?? moduleConfig?.defaultMapperIn ?? '',
    outgoingMapperId: spec.outgoingMapperId ?? moduleConfig?.defaultMapperOut ?? '',
  }
}

/** XSOAR param type for an "authentication" (credentials) field — value is an object. */
const CREDENTIAL_PARAM_TYPE = 9

/**
 * Set declared parameter values onto a list of parameter records (matched by
 * `name` then `display`). A credentials param (type 9) is wrapped as a credential
 * object; a plain encrypted param (type 4) takes the string value (XSOAR encrypts
 * it server-side). When `skipSecrets` is set, masked params (type 4/9) are left
 * untouched — XSOAR returns them masked, so re-writing from a masked read would
 * clobber the stored secret. A declared param with no matching definition is
 * appended as a plain name/value pair.
 */
function applyParamValues(
  params: LiveIntegrationParam[],
  declared: Record<string, string>,
  opts: { skipSecrets: boolean },
): void {
  const matched = new Set<string>()
  for (const param of params) {
    const key =
      param.name !== undefined && declared[param.name] !== undefined
        ? param.name
        : param.display !== undefined && declared[param.display] !== undefined
          ? param.display
          : undefined
    if (key === undefined) continue

    const isMasked = typeof param.type === 'number' && SECRET_PARAM_TYPES.has(param.type)
    if (isMasked && opts.skipSecrets) {
      matched.add(key)
      continue
    }
    param.value = param.type === CREDENTIAL_PARAM_TYPE ? credentialValue(declared[key]) : declared[key]
    param.hasvalue = true
    matched.add(key)
  }

  for (const [key, value] of Object.entries(declared)) {
    if (!matched.has(key)) params.push({ name: key, value, hasvalue: true })
  }
}

/** Wrap a single secret into the credential object shape XSOAR expects (type 9). */
function credentialValue(secret: string): Record<string, unknown> {
  return { credential: '', identifier: '', password: secret, passwordChanged: true }
}
