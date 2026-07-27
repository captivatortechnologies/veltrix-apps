import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildFalconClient,
  falconErrorMessage,
  falconFailure,
  fqlEscape,
  parseEnvelope,
  type FalconClient,
} from '../../lib/falcon'
import { extractParserSpecs, type LiveParser, type ParserSpec } from './validate'

/** Parser fields this app manages and can restore on rollback. */
export interface ParserRollbackEntry {
  name: string
  repository: string
  existed: boolean
  id?: string
  prior?: {
    /** The parser script prior to this deployment — restored on rollback. */
    script?: string
    /** Tracked for the config record; not written to the verified endpoint. */
    datatype?: string
    enabled?: boolean
  }
}

/**
 * Deploy Next-Gen SIEM parsers to a Falcon tenant.
 *
 * Falcon exposes two parser surfaces:
 *   - A JSON CRUD surface at /ngsiem-content/entities/parsers/v1 (create/update
 *     accept {name, repository, script}) plus /ngsiem-content/queries/parsers/v1
 *     to list ids.
 *   - A multipart "…/parsers-template/v1" surface that uploads the script as a
 *     YAML file.
 * This app uses the JSON surface: the shared FalconClient speaks JSON, and the
 * JSON body carries the parser script inline. Only name/repository/script are
 * written — datatype and enabled are canvas metadata the JSON endpoint does not
 * model (they are captured for rollback but never sent).
 *
 * For each declared parser:
 *   - GET  /ngsiem-content/queries/parsers/v1?filter=name:'…'  — find its id
 *   - GET  /ngsiem-content/entities/parsers/v1?ids=…            — capture prior script
 *   - PATCH /ngsiem-content/entities/parsers/v1                 — update existing
 *   - POST  /ngsiem-content/entities/parsers/v1                 — create missing
 *
 * A parser's name is its identity and is immutable — the API rejects name
 * changes, so renaming means delete-and-recreate.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractParserSpecs(ctx.canvas).filter((s) => s.name && s.script.trim())
  const rollbackState: ParserRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await findParserByName(client, spec.name, spec.repository)

      if (existing?.id) {
        rollbackState.push({
          name: spec.name,
          repository: spec.repository,
          existed: true,
          id: existing.id,
          prior: { script: existing.script, datatype: spec.datatype, enabled: spec.enabled },
        })

        await updateParser(client, {
          id: existing.id,
          name: spec.name,
          repository: spec.repository,
          script: spec.script,
        })
      } else {
        const id = await createParser(client, {
          name: spec.name,
          repository: spec.repository,
          script: spec.script,
        })
        rollbackState.push({ name: spec.name, repository: spec.repository, existed: false, id })
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Next-Gen SIEM parser(s) to Falcon tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedParsers: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Parser deployment failed after ${deployed.length} of ${specs.length} parser(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedParsers: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers ---

/**
 * Look up a parser by exact name within a repository. The queries endpoint
 * returns matching ids; the entities endpoint resolves them to full parsers,
 * and the exact name is pinned client-side. Returns null when none matches.
 */
export async function findParserByName(
  client: FalconClient,
  name: string,
  repository: string,
): Promise<LiveParser | null> {
  const limit = 100
  for (let offset = 0; ; offset += limit) {
    const res = await client.request('GET', '/ngsiem-content/queries/parsers/v1', {
      query: {
        filter: `name:'${fqlEscape(name)}'`,
        repository,
        parser_type: 'custom',
        limit,
        offset,
      },
    })
    if (!res.ok) {
      throw new Error(`Failed to search parser "${name}": ${falconErrorMessage(res)}`)
    }
    const ids = (parseEnvelope<string>(res.body)?.resources ?? []).filter(
      (id): id is string => typeof id === 'string',
    )
    if (ids.length > 0) {
      const parsers = await getParsersByIds(client, ids, repository)
      const exact = parsers.find((p) => p.name === name)
      if (exact) return exact
    }
    if (ids.length < limit) break
  }
  return null
}

/**
 * Resolve parser ids to full parser objects. The FalconClient query serializer
 * cannot repeat `ids=`, so parsers are fetched one id at a time — the exact-name
 * lookup normally resolves a single id.
 */
export async function getParsersByIds(
  client: FalconClient,
  ids: string[],
  repository: string,
): Promise<LiveParser[]> {
  const parsers: LiveParser[] = []
  for (const id of ids) {
    const res = await client.request('GET', '/ngsiem-content/entities/parsers/v1', {
      query: { ids: id, repository },
    })
    if (!res.ok) {
      throw new Error(`Failed to read parser ${id}: ${falconErrorMessage(res)}`)
    }
    parsers.push(...(parseEnvelope<LiveParser>(res.body)?.resources ?? []))
  }
  return parsers
}

/** Create a parser; returns the new id (or throws). */
export async function createParser(
  client: FalconClient,
  body: { name: string; repository: string; script: string },
): Promise<string> {
  const res = await client.request('POST', '/ngsiem-content/entities/parsers/v1', { body })
  const failure = falconFailure(res)
  if (failure) throw new Error(`Failed to create parser "${body.name}": ${failure}`)
  const created = parseEnvelope<LiveParser | string>(res.body)?.resources?.[0]
  const id = typeof created === 'string' ? created : created?.id
  if (!id) throw new Error(`Parser "${body.name}" was created but the API returned no parser id`)
  return id
}

/** Update a parser (body must include its id). */
export async function updateParser(
  client: FalconClient,
  body: { id: string; name: string; repository: string; script: string },
): Promise<void> {
  const res = await client.request('PATCH', '/ngsiem-content/entities/parsers/v1', { body })
  const failure = falconFailure(res)
  if (failure) throw new Error(`Failed to update parser "${body.name}": ${failure}`)
}

/** Delete a parser by id within a repository. */
export async function deleteParser(
  client: FalconClient,
  id: string,
  repository: string,
): Promise<number> {
  const res = await client.request('DELETE', '/ngsiem-content/entities/parsers/v1', {
    query: { ids: id, repository },
  })
  const failure = res.status === 404 ? null : falconFailure(res)
  if (failure) throw new Error(`Failed to delete parser ${id}: ${failure}`)
  return res.status
}

/** Re-export so drift/health handlers share the one spec type. */
export type { ParserSpec }
