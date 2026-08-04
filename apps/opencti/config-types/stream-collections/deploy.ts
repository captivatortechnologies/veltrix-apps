import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import {
  ADD_STREAM_COLLECTION_MUTATION,
  LIST_STREAM_COLLECTIONS_QUERY,
  PATCH_STREAM_COLLECTION_MUTATION,
  buildStreamCollectionInput,
  buildStreamCollectionPatch,
  findStreamCollection,
  streamCollectionsFromList,
  type OpenctiStreamCollection,
} from './_shared'

/**
 * Deploy OpenCTI stream collections over the GraphQL API:
 *   read (rollback): streamCollections                → find the live collection by name
 *   create:          streamCollectionAdd(input) with { name, description?, filters?, origin_filters?, stream_live?, stream_public? }
 *   update:          streamCollectionEdit(id) { fieldPatch(input) } with [EditInput] (collection exists)
 *
 * The `name` is the stable identity used to upsert. rollbackData records, per
 * collection, the prior node (null when it did not exist) AND the id — so
 * rollback can restore the prior body or delete the one we created.
 *
 * NOTE: streamCollectionAdd returns the created collection (with its new id).
 */
async function listStreamCollections(base: string, headers: Record<string, string>): Promise<OpenctiStreamCollection[]> {
  try {
    return streamCollectionsFromList(await graphql<unknown>(base, headers, LIST_STREAM_COLLECTIONS_QUERY))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for stream-collection deployment' }
  }

  const base = buildOpenctiUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ name: string; collectionId: string | null; collection: OpenctiStreamCollection | null }> = []
  const applied: string[] = []

  try {
    const live = await listStreamCollections(base, headers)

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const existing = findStreamCollection(live, name)

      if (existing && existing.id != null) {
        const input = buildStreamCollectionPatch(item.fields)
        if (input.length > 0) {
          await graphql(base, headers, PATCH_STREAM_COLLECTION_MUTATION, { id: existing.id, input })
        }
        previous.push({ name, collectionId: String(existing.id), collection: existing })
      } else {
        const created = await graphql<{ streamCollectionAdd?: OpenctiStreamCollection }>(
          base,
          headers,
          ADD_STREAM_COLLECTION_MUTATION,
          { input: buildStreamCollectionInput(item.fields) },
        )
        const newId = created?.streamCollectionAdd?.id ?? null
        previous.push({ name, collectionId: newId ? String(newId) : null, collection: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} stream collection(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Stream-collection deploy failed after ${applied.length} collection(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
