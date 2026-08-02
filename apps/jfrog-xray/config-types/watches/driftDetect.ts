import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildXrayClient } from '../../lib/xrayApi'
import { watchPath, WATCHES_PATH } from './deploy'
import { buildAssignedPolicies, buildResources, extractWatchSpecs, findWatch, type XrayAssignedPolicy, type XrayWatch, type XrayWatchResource } from './_shared'

/**
 * Detect drift between the last-deployed watch configuration and the live Xray
 * tenant. Re-reads each declared watch by name (`GET /api/v2/watches/{name}`)
 * and compares:
 *   - existence (a missing watch is CRITICAL drift)
 *   - active/description
 *   - assigned policies (name + type set)
 *   - resource scope (compared by {type, name} pairs — best-effort, since a
 *     resource's filters are open-ended and not diffed field-by-field)
 *   - watch recipients and ticket-creation flag
 * Best-effort and read-only: any transport failure reports no drift rather
 * than a false positive.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildXrayClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractWatchSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs }

  let live: XrayWatch[]
  try {
    live = await client.getJson<XrayWatch[]>(WATCHES_PATH)
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const spec of specs) {
    const label = spec.name
    const summary = findWatch(live, spec.name)
    if (!summary) {
      diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    let full: XrayWatch
    try {
      full = await client.getJson<XrayWatch>(watchPath(spec.name))
    } catch {
      continue
    }

    const liveActive = full.general_data?.active !== false
    if (liveActive !== spec.active) {
      diffs.push({ field: `${label}.active`, expected: String(spec.active), actual: String(liveActive), severity: 'warning' })
    }
    if (spec.description !== undefined) {
      const liveDescription = full.general_data?.description ?? ''
      if (spec.description !== liveDescription) {
        diffs.push({ field: `${label}.description`, expected: spec.description, actual: liveDescription || '(none)', severity: 'warning' })
      }
    }

    diffAssignedPolicies(label, buildAssignedPolicies(spec), full.assigned_policies ?? [], diffs)
    diffResources(label, buildResources(spec), full.project_resources?.resources ?? [], diffs)

    const desiredRecipients = [...spec.watchRecipients].sort()
    const liveRecipients = [...(full.watch_recipients ?? [])].sort()
    if (JSON.stringify(desiredRecipients) !== JSON.stringify(liveRecipients)) {
      diffs.push({
        field: `${label}.watch_recipients`,
        expected: desiredRecipients.join(', ') || '(none)',
        actual: liveRecipients.join(', ') || '(none)',
        severity: 'warning',
      })
    }

    const liveCreateTicket = full.create_ticket_enabled ?? false
    if (spec.createTicketEnabled !== liveCreateTicket) {
      diffs.push({ field: `${label}.create_ticket_enabled`, expected: String(spec.createTicketEnabled), actual: String(liveCreateTicket), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

function policyKeyOf(p: XrayAssignedPolicy): string {
  return `${p.type}:${p.name}`
}

function diffAssignedPolicies(label: string, desired: XrayAssignedPolicy[], live: XrayAssignedPolicy[], diffs: DriftDiff[]): void {
  const desiredKeys = desired.map(policyKeyOf).sort()
  const liveKeys = live.map(policyKeyOf).sort()
  if (JSON.stringify(desiredKeys) !== JSON.stringify(liveKeys)) {
    diffs.push({
      field: `${label}.assigned_policies`,
      expected: desiredKeys.join(', ') || '(none)',
      actual: liveKeys.join(', ') || '(none)',
      severity: 'warning',
    })
  }
}

function resourceKeyOf(r: XrayWatchResource): string {
  return `${r.type}:${r.name ?? ''}`
}

function diffResources(label: string, desired: XrayWatchResource[], live: XrayWatchResource[], diffs: DriftDiff[]): void {
  const desiredKeys = desired.map(resourceKeyOf).sort()
  const liveKeys = live.map(resourceKeyOf).sort()
  if (JSON.stringify(desiredKeys) !== JSON.stringify(liveKeys)) {
    diffs.push({
      field: `${label}.resources`,
      expected: desiredKeys.join(', ') || '(none)',
      actual: liveKeys.join(', ') || '(none)',
      severity: 'warning',
    })
  }
}
