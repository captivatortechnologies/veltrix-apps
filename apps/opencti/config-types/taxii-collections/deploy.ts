import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import {
  ADD_TAXII_COLLECTION_MUTATION,
  LIST_TAXII_COLLECTIONS_QUERY,
  PATCH_TAXII_COLLECTION_MUTATION,
  buildTaxiiCollectionInput,
  buildTaxiiCollectionPatch,
  findTaxiiCollection,
  taxiiCollectionsFromList,
  type OpenctiTaxiiCollection,
} from './_shared'

/**
 * Deploy OpenCTI TAXII collections over the GraphQL API:
 *   read (rollback): taxiiCollections                → find the live collection by name
 *   create:          taxiiCollectionAdd(input) with { name, description?, filters?, taxii_public?, include_inferences?, score_to_confidence? }
 *   update:          taxiiCollectionEdit(id) { fieldPatch(input) } with [EditInput] (collection exists)
 *
 * The `name` is the stable identity used to upsert. rollbackData records, per
 * collection, the prior node (null when it did not exist) AND the id — so
 * rollback can restore the prior body or delete the one we created.
 *
 * NOTE: taxiiCollectionAdd returns the created collection (with its new id).
 */
async function listTaxiiCollections(base: string, headers: Record<string, string>): Promise<OpenctiTaxiiCollection[]> {
  try {
    return taxiiCollectionsFromList(await graphql<unknown>(base, headers, LIST_TAXII_COLLECTIONS_QUERY))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for taxii-collection deployment' }
  }

  const base = buildOpenctiUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ name: string; collectionId: string | null; collection: OpenctiTaxiiCollection | null }> = []
  const applied: string[] = []

  try {
    const live = await listTaxiiCollections(base, headers)

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const existing = findTaxiiCollection(live, name)

      if (existing && existing.id != null) {
        const input = buildTaxiiCollectionPatch(item.fields)
        if (input.length > 0) {
          await graphql(base, headers, PATCH_TAXII_COLLECTION_MUTATION, { id: existing.id, input })
        }
        previous.push({ name, collectionId: String(existing.id), collection: existing })
      } else {
        const created = await graphql<{ taxiiCollectionAdd?: OpenctiTaxiiCollection }>(
          base,
          headers,
          ADD_TAXII_COLLECTION_MUTATION,
          { input: buildTaxiiCollectionInput(item.fields) },
        )
        const newId = created?.taxiiCollectionAdd?.id ?? null
        previous.push({ name, collectionId: newId ? String(newId) : null, collection: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} TAXII collection(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `TAXII-collection deploy failed after ${applied.length} collection(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
