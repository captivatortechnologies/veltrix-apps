import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import { DELETE_VOCABULARY_MUTATION, PATCH_VOCABULARY_MUTATION, buildRestorePatch, type OpenctiVocabulary } from './_shared'

/**
 * Undo a vocabularies deploy from rollbackData.previous (written by deploy()):
 * for each entry with a prior body, vocabularyFieldPatch(id, input) restores it;
 * a newly created entry (prior body null) is deleted via vocabularyDelete(id).
 * Applied over the OpenCTI GraphQL API. Verified against the OpenCTI GraphQL
 * backend schema (opencti-platform/opencti, src/modules/vocabulary/vocabulary.graphql).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ category: string; name: string; vocabularyId: string | null; vocabulary: OpenctiVocabulary | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for vocabulary rollback' }
  }

  const base = buildOpenctiUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { vocabularyId, vocabulary } of previous) {
      if (vocabularyId == null) {
        // A created entry whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      if (vocabulary) {
        const input = buildRestorePatch(vocabulary)
        if (input.length > 0) {
          await graphql(base, headers, PATCH_VOCABULARY_MUTATION, { id: vocabularyId, input })
        }
        restored++
      } else {
        await graphql(base, headers, DELETE_VOCABULARY_MUTATION, { id: vocabularyId })
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back vocabularies: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
