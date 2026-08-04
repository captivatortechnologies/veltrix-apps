import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, getJson, sendJson } from '../../lib/graylogApi'
import { asString } from '../../lib/coerce'
import { buildOutputBody, outputsFromList, findOutput, type GraylogOutput } from './_shared'

/**
 * Deploy Graylog message outputs over the REST API:
 *   read (rollback): GET  /api/system/outputs       → find the live output by title
 *   create:          POST /api/system/outputs        → OutputSummary { id, ... }
 *   update:          PUT  /api/system/outputs/{id}   → OutputSummary (deltas — see
 *                                                       the merge-not-replace note in _shared.ts)
 *
 * The output TITLE is the stable identity used to upsert. rollbackData
 * records, per output, the prior output (null when it did not exist) AND its
 * id — so rollback can restore the prior configuration or delete the one we
 * created.
 */
interface OutputCreateResponse {
  id?: string
}

async function listOutputs(base: string, headers: Record<string, string>): Promise<GraylogOutput[]> {
  try {
    return outputsFromList(await getJson<unknown>(`${base}/api/system/outputs`, headers))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for output deployment' }
  }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ title: string; outputId: string | null; output: GraylogOutput | null }> = []
  const applied: string[] = []

  try {
    const live = await listOutputs(base, headers)

    for (const item of items) {
      const title = asString(item.fields.title)
      if (!title) continue

      const { body, error } = buildOutputBody(item.fields)
      if (error || !body) throw new Error(`Output "${title}": ${error ?? 'could not build request body'}`)

      const existing = findOutput(live, title)
      if (existing && existing.id) {
        await sendJson('PUT', `${base}/api/system/outputs/${encodeURIComponent(existing.id)}`, headers, body)
        previous.push({ title, outputId: existing.id, output: existing })
      } else {
        const created = await sendJson<OutputCreateResponse>('POST', `${base}/api/system/outputs`, headers, body)
        previous.push({ title, outputId: created?.id ?? null, output: null })
      }
      applied.push(title)
    }

    return {
      success: true,
      message: `Applied ${applied.length} output(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Output deploy failed after ${applied.length} output(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
