import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import {
  ADD_VOCABULARY_MUTATION,
  LIST_VOCABULARIES_QUERY,
  PATCH_VOCABULARY_MUTATION,
  buildVocabularyInput,
  buildVocabularyPatch,
  findVocabulary,
  vocabulariesFromList,
  type OpenctiVocabulary,
} from './_shared'

/**
 * Deploy OpenCTI vocabulary entries over the GraphQL API:
 *   read (rollback): vocabularies             → find the live entry by category + name
 *   create:          vocabularyAdd(input) with { name, category, description?, order?, aliases? }
 *   update:          vocabularyFieldPatch(id, input) with [EditInput] (entry exists)
 *
 * `category` + `name` together are the stable compound identity used to upsert.
 * rollbackData records, per entry, the prior vocabulary node (null when it did
 * not exist) AND the entry id — so rollback can restore the prior body or delete
 * the one we created.
 *
 * NOTE: vocabularyAdd returns the created entry (with its new id). Verified
 * against the OpenCTI GraphQL backend schema (opencti-platform/opencti,
 * src/modules/vocabulary/vocabulary.graphql).
 */
async function listVocabularies(base: string, headers: Record<string, string>): Promise<OpenctiVocabulary[]> {
  try {
    return vocabulariesFromList(await graphql<unknown>(base, headers, LIST_VOCABULARIES_QUERY))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for vocabulary deployment' }
  }

  const base = buildOpenctiUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{
    category: string
    name: string
    vocabularyId: string | null
    vocabulary: OpenctiVocabulary | null
  }> = []
  const applied: string[] = []

  try {
    const live = await listVocabularies(base, headers)

    for (const item of items) {
      const category = String(item.fields.category ?? '').trim()
      const name = String(item.fields.name ?? '').trim()
      if (!category || !name) continue

      const existing = findVocabulary(live, category, name)

      if (existing && existing.id != null) {
        const input = buildVocabularyPatch(item.fields)
        if (input.length > 0) {
          await graphql(base, headers, PATCH_VOCABULARY_MUTATION, { id: existing.id, input })
        }
        previous.push({ category, name, vocabularyId: String(existing.id), vocabulary: existing })
      } else {
        const created = await graphql<{ vocabularyAdd?: OpenctiVocabulary }>(base, headers, ADD_VOCABULARY_MUTATION, {
          input: buildVocabularyInput(item.fields),
        })
        const newId = created?.vocabularyAdd?.id ?? null
        previous.push({ category, name, vocabularyId: newId ? String(newId) : null, vocabulary: null })
      }
      applied.push(`${category}/${name}`)
    }

    return {
      success: true,
      message: `Applied ${applied.length} vocabulary entr${applied.length === 1 ? 'y' : 'ies'}: ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Vocabulary deploy failed after ${applied.length} entr${applied.length === 1 ? 'y' : 'ies'}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
