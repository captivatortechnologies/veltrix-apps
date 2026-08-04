import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildXsoarClient } from '../../lib/xsoar'
import {
  CLASSIFICATION_VERSION,
  isProtectedClassification,
  MAPPER_TYPE_BY_DIRECTION,
  mapperDirectionOf,
  parseConfigBlob,
  saveClassification,
  searchClassifications,
  type LiveClassification,
} from '../lib/xsoarClassification'
import { extractMapperSpecs, type MapperSpec } from './validate'

export interface MapperRollbackEntry {
  id: string
  existed: boolean
  prior?: LiveClassification
}

/** Build the body sent to POST /classifier/import for a create or update. */
function buildMapperBody(spec: MapperSpec, live: LiveClassification | null): Record<string, unknown> {
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description ?? '',
    type: MAPPER_TYPE_BY_DIRECTION[spec.direction],
    feed: spec.feed,
    defaultIncidentType: spec.defaultIncidentType ?? '',
    definitionId: spec.definitionId ?? '',
    mapping: parseConfigBlob(spec.mapperConfig).value,
    version: typeof live?.version === 'number' ? live.version : CLASSIFICATION_VERSION,
  }
}

/**
 * Deploy Cortex XSOAR mappers via the server REST API.
 *
 * Identity is the caller-chosen mapper `id`. List every classifier/mapper
 * (POST /classifier/search, filtered to a mapper `type`), match on id, then
 * upsert with POST /classifier/import. Built-in / locked mappers are never
 * modified.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildXsoarClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, serverUrl } = built

  const specs = extractMapperSpecs(ctx.canvas).filter((s) => s.id)
  const rollbackState: MapperRollbackEntry[] = []
  const deployed: string[] = []

  try {
    const existing = await searchClassifications(client)
    const byId = new Map(
      existing.filter((c) => mapperDirectionOf(c.type) !== null && c.id).map((c) => [c.id as string, c]),
    )

    for (const spec of specs) {
      const live = byId.get(spec.id) ?? null

      if (live && isProtectedClassification(live)) {
        throw new Error(`Mapper "${spec.id}" is a built-in/locked mapper and cannot be modified`)
      }

      const body = buildMapperBody(spec, live)
      await saveClassification(client, spec.id, body)
      rollbackState.push({ id: spec.id, existed: live !== null, prior: live ?? undefined })
      deployed.push(spec.id)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} mapper(s) to ${serverUrl}: ${deployed.join(', ')}`,
      artifacts: { serverUrl, deployedMappers: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Mapper deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { serverUrl, deployedMappers: deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}
