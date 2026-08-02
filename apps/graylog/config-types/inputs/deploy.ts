import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, getJson, sendJson } from '../../lib/graylogApi'
import { asString } from '../../lib/coerce'
import { buildInputBody, inputsFromList, findInput, type GraylogInput, type InputCreatedResponse } from './_shared'

/**
 * Deploy Graylog message inputs over the REST API:
 *   read (rollback): GET    /api/system/inputs          → find the live input by title
 *   create:          POST   /api/system/inputs          → { id } (InputCreated)
 *   update:          PUT    /api/system/inputs/{inputId} → { id }
 *
 * The input TITLE is the stable identity used to upsert. rollbackData records,
 * per input, the prior input summary (null when it did not exist) AND the input
 * id — so rollback can restore the prior config or delete the one we created.
 */
async function listInputs(base: string, headers: Record<string, string>): Promise<GraylogInput[]> {
  try {
    return inputsFromList(await getJson<unknown>(`${base}/api/system/inputs`, headers))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for input deployment' }
  }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ title: string; inputId: string | null; input: GraylogInput | null }> = []
  const applied: string[] = []

  try {
    const live = await listInputs(base, headers)

    for (const item of items) {
      const title = asString(item.fields.title)
      if (!title) continue

      const { body, error } = buildInputBody(item.fields)
      if (error || !body) throw new Error(`Input "${title}": ${error ?? 'could not build request body'}`)

      const existing = findInput(live, title)
      if (existing && existing.id) {
        await sendJson('PUT', `${base}/api/system/inputs/${encodeURIComponent(existing.id)}`, headers, body)
        previous.push({ title, inputId: existing.id, input: existing })
      } else {
        const created = await sendJson<InputCreatedResponse>('POST', `${base}/api/system/inputs`, headers, body)
        previous.push({ title, inputId: created?.id ?? null, input: null })
      }
      applied.push(title)
    }

    return {
      success: true,
      message: `Applied ${applied.length} input(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Input deploy failed after ${applied.length} input(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
