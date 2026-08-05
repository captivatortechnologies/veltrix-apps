import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient } from '../../lib/snyk'
import { attachDriftActor, veltrixActorLogins } from '../../lib/snykAuditLog'
import { readIacCustomRules } from './deploy'
import { buildCustomRulesAttributes, extractIacSettings } from './validate'

/** Snyk audit event-name prefixes for org IaC-settings changes (best-effort attribution). */
const IAC_EVENT_PREFIXES = ['org.iac_settings', 'org.settings']

/**
 * Detect drift between the deployed IaC custom-rules settings and the live
 * org: compare each managed key (is_enabled, inherit_from_parent,
 * oci_registry_url, oci_registry_tag) individually so drift pinpoints exactly
 * which one changed.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildSnykClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built
  if (!client.hasOrg) return { hasDrift: false, diffs: [] }

  const spec = extractIacSettings(ctx.deployedConfig)
  const desired = buildCustomRulesAttributes(spec)

  try {
    const live = (await readIacCustomRules(client)) ?? {}

    const desiredEnabled = Boolean(desired.is_enabled)
    const liveEnabled = Boolean(live.is_enabled)
    if (desiredEnabled !== liveEnabled) {
      diffs.push({ field: 'custom_rules.is_enabled', expected: String(desiredEnabled), actual: String(liveEnabled), severity: 'warning' })
    }

    const desiredInherit = (desired.inherit_from_parent as string | undefined) ?? ''
    const liveInherit = live.inherit_from_parent ?? ''
    if (desiredInherit !== liveInherit) {
      diffs.push({ field: 'custom_rules.inherit_from_parent', expected: desiredInherit || '(none)', actual: liveInherit || '(none)', severity: 'warning' })
    }

    const desiredUrl = (desired.oci_registry_url as string | undefined) ?? ''
    const liveUrl = live.oci_registry_url ?? ''
    if (desiredUrl !== liveUrl) {
      diffs.push({ field: 'custom_rules.oci_registry_url', expected: desiredUrl || '(none)', actual: liveUrl || '(none)', severity: 'warning' })
    }

    const desiredTag = (desired.oci_registry_tag as string | undefined) ?? ''
    const liveTag = live.oci_registry_tag ?? ''
    if (desiredTag !== liveTag) {
      diffs.push({ field: 'custom_rules.oci_registry_tag', expected: desiredTag || '(none)', actual: liveTag || '(none)', severity: 'warning' })
    }

    await attachDriftActor(client, diffs, {
      eventPrefixes: IAC_EVENT_PREFIXES,
      excludeActorLogins: veltrixActorLogins(ctx.credential),
    })
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
