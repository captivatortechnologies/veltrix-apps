import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient } from '../../lib/snyk'
import { attachDriftActor, veltrixActorLogins } from '../../lib/snykAuditLog'
import { listWebhooks } from './deploy'
import { extractWebhookSpecs, webhookKey } from './validate'

/** Snyk audit event-name prefixes for webhook changes (best-effort attribution). */
const WEBHOOK_EVENT_PREFIXES = ['org.webhook']

/**
 * Detect drift between the deployed webhooks and the live org. A declared
 * webhook URL that no longer exists is critical drift. The signing secret is
 * write-only and never diffed.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildSnykClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built
  if (!client.hasOrg) return { hasDrift: false, diffs: [] }

  const specs = extractWebhookSpecs(ctx.deployedConfig).filter((s) => s.url)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listWebhooks(client)
    const excludeActorLogins = veltrixActorLogins(ctx.credential)
    const urls = new Set(live.filter((w) => w.url).map((w) => webhookKey(w.url as string)))
    for (const spec of specs) {
      if (!urls.has(webhookKey(spec.url))) {
        const before = diffs.length
        diffs.push({ field: `webhook:${spec.url}`, expected: 'exists', actual: 'missing', severity: 'critical' })

        // A declared webhook is gone (deleted) — attribute the removal by URL. Best-effort.
        await attachDriftActor(client, diffs.slice(before), {
          targetName: spec.url,
          eventPrefixes: WEBHOOK_EVENT_PREFIXES,
          excludeActorLogins,
        })
      }
    }
  } catch (error) {
    diffs.push({
      field: 'snyk',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
