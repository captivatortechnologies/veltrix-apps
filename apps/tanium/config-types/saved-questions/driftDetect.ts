import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildTaniumBaseUrl, resolveTaniumSession } from '../../lib/taniumApi'
import { getEntityByName } from '../../lib/taniumRestEntity'
import { SAVED_QUESTIONS_RESOURCE, savedQuestionText, type TaniumSavedQuestion } from './_shared'

/**
 * Drift for saved questions: compare the declared question text against the live
 * saved question in Tanium. Best-effort — a question that can't be matched
 * (missing / transient error) is skipped rather than raising false drift. Only
 * asserts drift for items authored by text (a by-id item has no local text to
 * compare). Read-only: GET /api/v2/saved_questions/by-name/{name}.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildTaniumBaseUrl(component, connectivity, connectivityProvider)

  let session: string
  try {
    session = await resolveTaniumSession(base, credential)
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    const expected = String(item.fields.questionText ?? '').trim()
    const questionId = String(item.fields.questionId ?? '').trim()
    if (!name || !expected || questionId) continue

    let match: TaniumSavedQuestion | null
    try {
      match = await getEntityByName<TaniumSavedQuestion>(base, session, SAVED_QUESTIONS_RESOURCE, name)
    } catch {
      continue
    }
    if (!match) continue

    const actual = savedQuestionText(match)
    if (actual && actual !== expected) {
      diffs.push({ field: `${name}.questionText`, expected, actual, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
