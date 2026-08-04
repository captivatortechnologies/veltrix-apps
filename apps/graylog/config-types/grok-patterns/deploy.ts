import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, getJson, sendJson } from '../../lib/graylogApi'
import { asString } from '../../lib/coerce'
import { buildGrokPatternBody, grokPatternsFromList, findGrokPattern, type GraylogGrokPattern } from './_shared'

/**
 * Deploy Graylog grok patterns over the REST API:
 *   read (rollback): GET  /api/system/grok              → find the live pattern by name
 *   create:          POST /api/system/grok               → GrokPattern { id, name, pattern }
 *   update:          PUT  /api/system/grok/{id}          → GrokPattern
 *
 * The pattern NAME is the stable identity used to upsert. rollbackData records,
 * per pattern, the prior pattern (null when it did not exist) AND its id — so
 * rollback can restore the prior definition or delete the one we created.
 */
interface GrokPatternCreateResponse {
  id?: string
}

async function listGrokPatterns(base: string, headers: Record<string, string>): Promise<GraylogGrokPattern[]> {
  try {
    return grokPatternsFromList(await getJson<unknown>(`${base}/api/system/grok`, headers))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for grok-pattern deployment' }
  }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ name: string; patternId: string | null; pattern: GraylogGrokPattern | null }> = []
  const applied: string[] = []

  try {
    const live = await listGrokPatterns(base, headers)

    for (const item of items) {
      const name = asString(item.fields.name)
      if (!name) continue

      const body = buildGrokPatternBody(item.fields)
      const existing = findGrokPattern(live, name)

      if (existing && existing.id) {
        await sendJson('PUT', `${base}/api/system/grok/${encodeURIComponent(existing.id)}`, headers, body)
        previous.push({ name, patternId: existing.id, pattern: existing })
      } else {
        const created = await sendJson<GrokPatternCreateResponse>('POST', `${base}/api/system/grok`, headers, body)
        previous.push({ name, patternId: created?.id ?? null, pattern: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} grok pattern(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Grok-pattern deploy failed after ${applied.length} pattern(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
