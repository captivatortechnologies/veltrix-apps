import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildTaniumBaseUrl, resolveTaniumSession } from '../../lib/taniumApi'
import { upsertEntity, type UpsertRecord } from '../../lib/taniumRestEntity'
import { SAVED_QUESTIONS_RESOURCE, buildSavedQuestionBody, type TaniumSavedQuestion } from './_shared'

/**
 * Deploy Tanium saved questions over the REST v2 API (443). The name is the stable
 * identity used to upsert:
 *   lookup: GET    /api/v2/saved_questions/by-name/{name}
 *   update: DELETE /api/v2/saved_questions/{id} then POST /api/v2/saved_questions
 *   create: POST   /api/v2/saved_questions            with { name, question }
 *
 * REST v2 exposes no confirmed in-place update for saved questions, so an existing
 * one is replaced (delete + recreate) — this churns the object id, which may break
 * references from dashboards/saved actions. Verify against a live Tanium.
 * rollbackData records, per item, the prior object (null when new) and the created id.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for saved-question deployment' }
  }

  const base = buildTaniumBaseUrl(component, connectivity, connectivityProvider)
  const previous: Array<UpsertRecord<TaniumSavedQuestion>> = []
  const applied: string[] = []

  try {
    const session = await resolveTaniumSession(base, credential)

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue
      const body = buildSavedQuestionBody(item.fields)
      previous.push(await upsertEntity<TaniumSavedQuestion>(base, session, SAVED_QUESTIONS_RESOURCE, name, body))
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} saved question(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Saved-question deploy failed after ${applied.length} question(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
