import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient, elasticErrorMessage, parseJson, type ElasticClient } from '../../lib/elastic'
import { definitionOf, extractTemplateSpecs, parseJsonObject, type LiveTimeline, type TimelineTemplateSpec } from './validate'

export interface TimelineTemplateRollbackEntry {
  templateTimelineId: string
  existed: boolean
  /** Kibana's saved-object id — needed to PATCH/DELETE. */
  savedObjectId?: string
  /** The prior live timeline, captured so an update can be restored. */
  prior?: LiveTimeline
}

/**
 * Deploy Elastic Security timeline TEMPLATES via the Kibana Security Timeline
 * API.
 *
 * Identity is `templateTimelineId` (a caller-chosen, stable UUID/string) —
 * Kibana's own saved-object id (`savedObjectId`) and optimistic-concurrency
 * `version` token are server-managed. `templateTimelineVersion` (the counter
 * Elastic itself uses to detect "a newer definition exists") is ALSO managed
 * by this app: 1 on create, incremented by 1 on every update.
 *   - GET   /api/timeline?template_timeline_id={id}  — 404 = absent
 *   - POST  /api/timeline                             — create when absent
 *   - PATCH /api/timeline                              — update when present
 *     (requires the CURRENT `savedObjectId` + `version` OCC token from the GET
 *     above — Kibana rejects a PATCH carrying a stale version)
 *
 * Timeline templates are a Kibana endpoint, so all requests go through
 * client.kibana().
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildElasticClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, kibanaUrl } = built

  const specs = extractTemplateSpecs(ctx.canvas).filter((s) => s.templateTimelineId && s.title)
  const rollbackState: TimelineTemplateRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const label = spec.templateTimelineId
      const definition = spec.definitionJson ? parseJsonObject(spec.definitionJson) : null
      if (spec.definitionJson && !definition) {
        throw new Error(`Timeline template "${label}": Definition is not a valid JSON object`)
      }

      const existing = await getTimelineTemplate(client, spec.templateTimelineId)

      if (!existing) {
        const body = {
          timeline: buildTimelineBody(spec, definition ?? {}, 1),
          templateTimelineId: spec.templateTimelineId,
          templateTimelineVersion: 1,
          timelineType: 'template',
        }
        const res = await client.kibana('POST', '/api/timeline', { body })
        if (!res.ok) {
          throw new Error(`Failed to create timeline template "${label}": ${elasticErrorMessage(res)}`)
        }
        const created = parseJson<LiveTimeline>(res.body)
        rollbackState.push({ templateTimelineId: spec.templateTimelineId, existed: false, savedObjectId: created?.savedObjectId })
        createdIds.push(spec.templateTimelineId)
      } else {
        rollbackState.push({
          templateTimelineId: spec.templateTimelineId,
          existed: true,
          savedObjectId: existing.savedObjectId,
          prior: existing,
        })

        const nextVersion = (existing.templateTimelineVersion ?? 0) + 1
        const res = await client.kibana('PATCH', '/api/timeline', {
          body: {
            timeline: buildTimelineBody(spec, definition ?? {}, nextVersion),
            timelineId: existing.savedObjectId,
            version: existing.version,
          },
        })
        if (!res.ok) {
          throw new Error(`Failed to update timeline template "${label}": ${elasticErrorMessage(res)}`)
        }
      }

      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} timeline template(s) to Kibana at ${kibanaUrl}: ${deployed.join(', ')}`,
      artifacts: { kibanaUrl, deployedTemplates: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Timeline template deployment failed after ${deployed.length} of ${specs.length} template(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { kibanaUrl, deployedTemplates: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** Find a timeline TEMPLATE by templateTimelineId; null on 404 (absent). */
export async function getTimelineTemplate(client: ElasticClient, templateTimelineId: string): Promise<LiveTimeline | null> {
  const res = await client.kibana('GET', '/api/timeline', { query: { template_timeline_id: templateTimelineId } })
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to read timeline template "${templateTimelineId}": ${elasticErrorMessage(res)}`)
  }
  return parseJson<LiveTimeline>(res.body)
}

/** Build the `timeline` object sent on both create (POST) and update (PATCH). */
export function buildTimelineBody(
  spec: TimelineTemplateSpec,
  definition: Record<string, unknown>,
  templateTimelineVersion: number,
): Record<string, unknown> {
  return {
    ...definition,
    title: spec.title,
    description: spec.description ?? '',
    timelineType: 'template',
    status: 'active',
    templateTimelineId: spec.templateTimelineId,
    templateTimelineVersion,
  }
}
