import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, getJson, sendJson } from '../../lib/graylogApi'
import { asString } from '../../lib/coerce'
import {
  buildExtractorBody,
  extractorsFromList,
  findExtractor,
  inputsFromList,
  findInput,
  type GraylogExtractor,
} from './_shared'

/**
 * Deploy Graylog extractors over the REST API:
 *   resolve:  GET  /api/system/inputs                                → input_title → input id
 *   read:     GET  /api/system/inputs/{inputId}/extractors           → find by title within the input
 *   create:   POST /api/system/inputs/{inputId}/extractors           → { id } (ExtractorCreated)
 *   update:   PUT  /api/system/inputs/{inputId}/extractors/{id}      → ExtractorSummary
 *
 * The (input, title) PAIR is the stable identity used to upsert — Graylog
 * assigns the extractor id. rollbackData records, per extractor, the prior
 * extractor (null when it did not exist) AND its id + input id — so rollback
 * can restore the prior config or delete the one we created. An input title
 * that can't be resolved fails that item's deploy loudly.
 */
interface ExtractorCreatedResponse {
  id?: string
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for extractor deployment' }
  }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ inputTitle: string; title: string; inputId: string; extractorId: string | null; extractor: GraylogExtractor | null }> = []
  const applied: string[] = []

  const inputIdCache = new Map<string, string>()
  const extractorListCache = new Map<string, GraylogExtractor[]>()

  async function resolveInputId(inputTitle: string): Promise<string> {
    if (inputIdCache.has(inputTitle)) return inputIdCache.get(inputTitle)!
    const live = inputsFromList(await getJson<unknown>(`${base}/api/system/inputs`, headers))
    const match = findInput(live, inputTitle)
    const id = match?.id ?? ''
    inputIdCache.set(inputTitle, id)
    return id
  }

  async function listExtractors(inputId: string): Promise<GraylogExtractor[]> {
    if (extractorListCache.has(inputId)) return extractorListCache.get(inputId)!
    let list: GraylogExtractor[] = []
    try {
      list = extractorsFromList(await getJson<unknown>(`${base}/api/system/inputs/${encodeURIComponent(inputId)}/extractors`, headers))
    } catch {
      list = []
    }
    extractorListCache.set(inputId, list)
    return list
  }

  try {
    for (const item of items) {
      const inputTitle = asString(item.fields.input_title)
      const title = asString(item.fields.title)
      if (!inputTitle || !title) continue

      const inputId = await resolveInputId(inputTitle)
      if (!inputId) throw new Error(`Input "${inputTitle}" was not found — cannot attach extractor "${title}".`)

      const { body, error } = buildExtractorBody(item.fields)
      if (error || !body) throw new Error(`Extractor "${title}" on input "${inputTitle}": ${error ?? 'could not build request body'}`)

      const live = await listExtractors(inputId)
      const existing = findExtractor(live, title)

      if (existing && existing.id) {
        await sendJson('PUT', `${base}/api/system/inputs/${encodeURIComponent(inputId)}/extractors/${encodeURIComponent(existing.id)}`, headers, body)
        previous.push({ inputTitle, title, inputId, extractorId: existing.id, extractor: existing })
      } else {
        const created = await sendJson<ExtractorCreatedResponse>(
          'POST',
          `${base}/api/system/inputs/${encodeURIComponent(inputId)}/extractors`,
          headers,
          body,
        )
        previous.push({ inputTitle, title, inputId, extractorId: created?.id ?? null, extractor: null })
      }
      // Invalidate the per-input cache so a later item targeting the same input
      // sees this one's create/update when matching by title.
      extractorListCache.delete(inputId)
      applied.push(`${inputTitle}/${title}`)
    }

    return {
      success: true,
      message: `Applied ${applied.length} extractor(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Extractor deploy failed after ${applied.length} extractor(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
