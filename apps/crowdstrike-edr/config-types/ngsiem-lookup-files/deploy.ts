import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildFalconClient,
  falconErrorMessage,
  falconFailure,
  parseEnvelope,
  type FalconClient,
  type FalconMethod,
} from '../../lib/falcon'
import { extractLookupSpecs, type LiveLookupFile, type LookupSpec } from './validate'

/** Lookup-file state this app manages and can restore on rollback. */
export interface LookupRollbackEntry {
  filename: string
  searchDomain: string
  existed: boolean
  prior?: {
    /** The CSV content prior to this deployment — restored on rollback. */
    content?: string
  }
}

/**
 * Deploy Next-Gen SIEM lookup files to a Falcon tenant.
 *
 * Falcon exposes two lookup-file surfaces:
 *   - A per-file surface at /ngsiem-content/entities/lookupfiles/v1 whose
 *     create/update require multipart/form-data (a file upload).
 *   - A JSON bulk surface at /ngsiem-content/entities/bulk-lookupfiles/v1 that
 *     carries the CSV content inline: { lookup_files: [{ filename, content }],
 *     search_domain }.
 * This app uses the JSON bulk surface for create/update (the shared FalconClient
 * speaks JSON), and the per-file DELETE for removal. The canvas "repository"
 * field maps to the API `search_domain`.
 *
 * For each declared file:
 *   - GET   /ngsiem-content/entities/bulk-lookupfiles/v1?filename=…  — find + capture prior content
 *   - PATCH /ngsiem-content/entities/bulk-lookupfiles/v1             — update existing (bulk, one file)
 *   - POST  /ngsiem-content/entities/bulk-lookupfiles/v1            — create missing (bulk, one file)
 *
 * A file's filename is its identity within a search_domain.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractLookupSpecs(ctx.canvas).filter((s) => s.filename && s.content.trim())
  const rollbackState: LookupRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await findLookupFile(client, spec.filename, spec.repository)

      if (existing) {
        rollbackState.push({
          filename: spec.filename,
          searchDomain: spec.repository,
          existed: true,
          prior: { content: existing.content },
        })
        await writeLookupFile(client, 'PATCH', spec.filename, spec.content, spec.repository)
      } else {
        rollbackState.push({
          filename: spec.filename,
          searchDomain: spec.repository,
          existed: false,
        })
        await writeLookupFile(client, 'POST', spec.filename, spec.content, spec.repository)
      }

      deployed.push(spec.filename)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Next-Gen SIEM lookup file(s) to Falcon tenant at ${baseUrl}: ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedLookupFiles: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Lookup file deployment failed after ${deployed.length} of ${specs.length} file(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedLookupFiles: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers ---

/**
 * Look up a file by exact filename within a search_domain via the JSON bulk-get
 * endpoint, which returns the file(s) including content. Returns null when
 * absent (404 or no match).
 */
export async function findLookupFile(
  client: FalconClient,
  filename: string,
  searchDomain: string,
): Promise<LiveLookupFile | null> {
  const res = await client.request('GET', '/ngsiem-content/entities/bulk-lookupfiles/v1', {
    query: { filename, search_domain: searchDomain },
  })
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to look up file "${filename}": ${falconErrorMessage(res)}`)
  }
  const resources = parseEnvelope<LiveLookupFile>(res.body)?.resources ?? []
  return resources.find((r) => r.filename === filename) ?? resources[0] ?? null
}

/**
 * Create or update a single lookup file through the JSON bulk endpoint. POST
 * creates, PATCH updates; both take the same inline-content body shape.
 */
export async function writeLookupFile(
  client: FalconClient,
  method: Extract<FalconMethod, 'POST' | 'PATCH'>,
  filename: string,
  content: string,
  searchDomain: string,
): Promise<void> {
  const res = await client.request(method, '/ngsiem-content/entities/bulk-lookupfiles/v1', {
    body: {
      lookup_files: [{ filename, content }],
      search_domain: searchDomain,
    },
  })
  const failure = falconFailure(res)
  if (failure) {
    const verb = method === 'POST' ? 'create' : 'update'
    throw new Error(`Failed to ${verb} lookup file "${filename}": ${failure}`)
  }
}

/** Delete a lookup file by filename within a search_domain. */
export async function deleteLookupFile(
  client: FalconClient,
  filename: string,
  searchDomain: string,
): Promise<number> {
  const res = await client.request('DELETE', '/ngsiem-content/entities/lookupfiles/v1', {
    query: { filename, search_domain: searchDomain },
  })
  const failure = res.status === 404 ? null : falconFailure(res)
  if (failure) throw new Error(`Failed to delete lookup file "${filename}": ${failure}`)
  return res.status
}

/** Re-export so drift/health handlers share the one spec type. */
export type { LookupSpec }
