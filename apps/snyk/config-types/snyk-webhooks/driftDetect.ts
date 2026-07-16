import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient } from '../../lib/snyk'
import { listWebhooks } from './deploy'
import { extractWebhookSpecs, webhookKey } from './validate'

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
    const urls = new Set(live.filter((w) => w.url).map((w) => webhookKey(w.url as string)))
    for (const spec of specs) {
      if (!urls.has(webhookKey(spec.url))) {
        diffs.push({ field: `webhook:${spec.url}`, expected: 'exists', actual: 'missing', severity: 'critical' })
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
