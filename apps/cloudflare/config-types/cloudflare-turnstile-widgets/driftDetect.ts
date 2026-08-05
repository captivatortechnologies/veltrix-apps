import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient } from '../../lib/cloudflare'
import { attachDriftActor, veltrixActorLogins } from '../lib/cloudflareAudit'
import { listWidgets } from './deploy'
import { extractTurnstileWidgetSpecs, widgetKey, type LiveTurnstileWidget } from './validate'

/** Normalize a domain list for comparison — trimmed, lower-cased, order-independent. */
function normalizeDomains(domains: string[] | undefined): string {
  return (domains ?? [])
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0)
    .sort()
    .join(',')
}

/**
 * Detect drift between the deployed Turnstile widget configuration and the live
 * account. Re-finds each declared widget by name and diffs every managed,
 * non-secret field (mode, domains, bot_fight_mode, offlabel, ephemeral_id,
 * clearance_level, region); a missing widget is critical drift. The `secret` is
 * never compared — it is write-only and Cloudflare redacts it on read.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  if (!(await client.hasAccount())) {
    return { hasDrift: false, diffs: [] }
  }

  const specs = extractTurnstileWidgetSpecs(ctx.deployedConfig).filter((s) => s.name && s.domains.length > 0)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  // Connection identity our own deploys appear under — excluded so attribution
  // reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await listWidgets(client)
    const byKey = new Map<string, LiveTurnstileWidget>(
      live.filter((w) => w.name).map((w) => [widgetKey(w.name as string), w]),
    )

    for (const spec of specs) {
      const before = diffs.length
      const label = spec.name
      const found = byKey.get(widgetKey(spec.name))
      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.name, excludeActorLogins })
        continue
      }

      if ((found.mode ?? '') !== spec.mode) {
        diffs.push({ field: `${label}.mode`, expected: spec.mode, actual: found.mode ?? 'not set', severity: 'warning' })
      }
      if (normalizeDomains(found.domains) !== normalizeDomains(spec.domains)) {
        diffs.push({
          field: `${label}.domains`,
          expected: spec.domains.join(', '),
          actual: (found.domains ?? []).join(', ') || 'not set',
          severity: 'warning',
        })
      }
      if ((found.bot_fight_mode === true) !== spec.botFightMode) {
        diffs.push({
          field: `${label}.bot_fight_mode`,
          expected: String(spec.botFightMode),
          actual: String(found.bot_fight_mode === true),
          severity: 'info',
        })
      }
      if ((found.offlabel === true) !== spec.offlabel) {
        diffs.push({
          field: `${label}.offlabel`,
          expected: String(spec.offlabel),
          actual: String(found.offlabel === true),
          severity: 'info',
        })
      }
      if ((found.ephemeral_id === true) !== spec.ephemeralId) {
        diffs.push({
          field: `${label}.ephemeral_id`,
          expected: String(spec.ephemeralId),
          actual: String(found.ephemeral_id === true),
          severity: 'info',
        })
      }
      if ((found.clearance_level ?? 'no_clearance') !== spec.clearanceLevel) {
        diffs.push({
          field: `${label}.clearance_level`,
          expected: spec.clearanceLevel,
          actual: found.clearance_level ?? 'not set',
          severity: 'info',
        })
      }
      // region is fixed at creation — reported for visibility only, not a fixable diff.
      if (found.region && found.region !== spec.region) {
        diffs.push({
          field: `${label}.region`,
          expected: `${spec.region} (fixed at creation — cannot be changed)`,
          actual: found.region,
          severity: 'info',
        })
      }
      // Attribute every diff this widget produced to the last human change (once).
      await attachDriftActor(client, diffs.slice(before), { targetId: found.sitekey, targetName: spec.name, excludeActorLogins })
    }
  } catch (error) {
    diffs.push({
      field: 'cloudflare',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
