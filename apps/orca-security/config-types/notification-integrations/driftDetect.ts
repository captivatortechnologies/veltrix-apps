import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildOrcaClient } from '../../lib/orcaApi'
import { canonicalJson, normalizeBool, normalizeStringList } from '../../lib/reconcile'
import { buildConfig, SERVICES, stripSecrets, type IntegrationService } from './_shared'
import { findIntegration } from './deploy'

/**
 * Drift for notification integrations: for each declared item, GET the live
 * integration by (service, template_name) and compare is_enabled, is_default
 * and the per-service config (secrets stripped before comparing) against what
 * we declare. businessUnits is compared only for webhook, since jira/slack
 * cannot be updated after create and this app does not attempt to enforce
 * agreement on a value the API itself will not let it correct. Best-effort —
 * an item that can't be found live is skipped. Read-only.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const built = buildOrcaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  for (const item of items) {
    const templateName = String(item.fields.templateName ?? '').trim()
    const service = String(item.fields.service ?? '').trim() as IntegrationService
    if (!templateName || !SERVICES.has(service)) continue

    const live = await findIntegration(client, service, templateName)
    if (!live) continue

    const label = `${templateName} (${service})`
    compare(diffs, label, 'isEnabled', normalizeBool(item.fields.isEnabled, true), normalizeBool(live.is_enabled, true))
    compare(diffs, label, 'isDefault', normalizeBool(item.fields.isDefault, false), normalizeBool(live.is_default, false))

    const expectedConfig = stripSecrets(service, buildConfig(service, item.fields))
    const liveConfig = stripSecrets(service, live.config)
    compare(diffs, label, 'config', canonicalJson(expectedConfig), canonicalJson(liveConfig))

    if (service === 'webhook') {
      const expectedUnits = normalizeStringList(item.fields.businessUnits)
      const liveUnits = Array.isArray(live.business_units) ? live.business_units.map((v) => String(v)) : []
      if ([...expectedUnits].sort().join('\n') !== [...liveUnits].sort().join('\n')) {
        diffs.push({ field: `${label}.businessUnits`, expected: expectedUnits, actual: liveUnits, severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

function compare(diffs: DriftDiff[], label: string, field: string, expected: unknown, actual: unknown): void {
  if (expected !== actual) {
    diffs.push({ field: `${label}.${field}`, expected, actual, severity: 'warning' })
  }
}
