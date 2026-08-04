import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildPagerDutyClient,
  pagerDutyErrorMessage,
  parseJson,
  type PagerDutyClient,
} from '../../lib/pagerdutyApi'
import {
  buildExtensionBody,
  extensionSchemaLabel,
  extractExtensionSpecs,
  findExtensionSchemaId,
  findServiceId,
  parseExtensionConfig,
  parseExtensionObjects,
  type LiveExtension,
  type LiveExtensionSchema,
} from './_shared'

const MAX_SCHEMA_NAMES_LISTED = 10

/** Per-extension rollback record captured during deploy. */
export interface ExtensionRollbackEntry {
  name: string
  existed: boolean
  id?: string
  prior?: LiveExtension
}

/**
 * Deploy PagerDuty extensions over the REST API v2:
 *   read (rollback): GET  /extensions          → find each live extension by name
 *   resolve schema:  GET  /extension_schemas    → extension schema NAME → id
 *   resolve objects: GET  /services             → each extension_objects NAME → id
 *   create:          POST /extensions           with { extension: {...} }
 *   update:          PUT  /extensions/{id}       with { extension: {...} }
 *
 * The name is the stable identity used to upsert. Each extension references an
 * extension schema and one or more services by name, resolved to ids here.
 * rollbackData records, per extension, whether it existed and its prior body —
 * so rollback can restore an updated extension or delete a newly created one.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildPagerDutyClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractExtensionSpecs(ctx.canvas).filter((s) => s.name && s.extensionSchemaName)
  const rollbackState: ExtensionRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listExtensions(client)
    const byName = new Map(existing.filter((e) => e.name).map((e) => [String(e.name).toLowerCase(), e]))
    const schemas = await listExtensionSchemas(client)
    const services = await listServices(client)

    for (const spec of specs) {
      const schemaId = findExtensionSchemaId(schemas, spec.extensionSchemaName)
      if (!schemaId) {
        const available = schemas.map(extensionSchemaLabel)
        const shown = available.slice(0, MAX_SCHEMA_NAMES_LISTED).join(', ')
        const suffix = available.length > MAX_SCHEMA_NAMES_LISTED ? `, and ${available.length - MAX_SCHEMA_NAMES_LISTED} more` : ''
        throw new Error(
          `Extension "${spec.name}" references extension schema "${spec.extensionSchemaName}" which was not found in the account. Available schemas: ${shown || '(none)'}${suffix}`,
        )
      }

      const objectsParsed = parseExtensionObjects(spec.extensionObjectsJson)
      if (objectsParsed.error || !objectsParsed.names) {
        throw new Error(`Extension "${spec.name}" has invalid extension_objects: ${objectsParsed.error ?? 'unknown'}`)
      }
      const serviceIds: string[] = []
      for (const objectName of objectsParsed.names) {
        const serviceId = findServiceId(services, objectName)
        if (!serviceId) {
          throw new Error(`Extension "${spec.name}" references service "${objectName}" which was not found in the account`)
        }
        serviceIds.push(serviceId)
      }

      const configParsed = parseExtensionConfig(spec.configJson)
      if (configParsed.error) {
        throw new Error(`Extension "${spec.name}" has an invalid config: ${configParsed.error}`)
      }

      const body = { extension: buildExtensionBody(spec, schemaId, serviceIds, configParsed.config) }
      const live = byName.get(spec.name.toLowerCase())

      if (live && live.id) {
        rollbackState.push({ name: spec.name, existed: true, id: live.id, prior: live })
        const res = await client.request('PUT', `/extensions/${encodeURIComponent(live.id)}`, { body })
        if (!res.ok) throw new Error(`Failed to update extension "${spec.name}": ${pagerDutyErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', '/extensions', { body })
        if (!res.ok) throw new Error(`Failed to create extension "${spec.name}": ${pagerDutyErrorMessage(res)}`)
        const created = parseJson<{ extension?: LiveExtension }>(res.body)?.extension
        if (!created?.id) throw new Error(`Extension "${spec.name}" was created but the API returned no id`)
        rollbackState.push({ name: spec.name, existed: false, id: created.id })
        createdIds.push(created.id)
      }
      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Applied ${deployed.length} extension(s): ${deployed.join(', ') || '(none)'}`,
      artifacts: { deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Extension deploy failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

/** List all extensions in the account; throws on a non-OK response. */
export async function listExtensions(client: PagerDutyClient): Promise<LiveExtension[]> {
  const res = await client.getAll<LiveExtension>('/extensions', 'extensions')
  if (!res.ok) {
    throw new Error(`Failed to list extensions: ${pagerDutyErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

/** List all extension schemas (extension_schema NAME → id resolution). */
export async function listExtensionSchemas(client: PagerDutyClient): Promise<LiveExtensionSchema[]> {
  const res = await client.getAll<LiveExtensionSchema>('/extension_schemas', 'extension_schemas')
  if (!res.ok) {
    throw new Error(
      `Failed to list extension schemas: ${pagerDutyErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

/** List all services (extension_objects NAME → id resolution). */
export async function listServices(client: PagerDutyClient): Promise<Array<{ id?: string; name?: string }>> {
  const res = await client.getAll<{ id?: string; name?: string }>('/services', 'services')
  if (!res.ok) {
    throw new Error(`Failed to list services: ${pagerDutyErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}
