import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildPagerDutyClient } from '../../lib/pagerdutyApi'
import {
  extractAutomationActionSpecs,
  findAutomationAction,
  findServiceId,
  findTeamId,
  liveServiceIds,
  liveTeamIds,
  parseNameList,
} from './_shared'
import { getAutomationAction, listAutomationActions, listServices, listTeams } from './deploy'

/**
 * Detect drift between the deployed automation-actions configuration and the
 * live PagerDuty account. Re-finds each declared action by its `name`:
 *   - a missing action is CRITICAL drift
 *   - a changed description, action_type, action_classification or invocation
 *     flag is WARNING drift
 *   - a declared team/service association that is not currently attached is
 *     WARNING drift (best-effort: an unresolvable name, or a failed per-action
 *     detail read, is skipped rather than reported — this app never asserts
 *     drift from a failed lookup, only from a confirmed mismatch, the same
 *     rule escalation-policies/driftDetect.ts documents)
 *
 * Team/service checks read the full action via a defensive GET-by-id (the list
 * response may not embed full association detail — see deploy.ts).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildPagerDutyClient(ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractAutomationActionSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs }

  let live
  try {
    live = await listAutomationActions(client)
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read actions, no drift asserted
  }

  let teams: Array<{ id?: string; name?: string }> | null = null
  let services: Array<{ id?: string; name?: string }> | null = null

  for (const spec of specs) {
    const match = findAutomationAction(live, spec.name)
    if (!match || !match.id) {
      diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    if (spec.description && String(match.description ?? '') !== spec.description) {
      diffs.push({
        field: `${spec.name}.description`,
        expected: spec.description,
        actual: String(match.description ?? ''),
        severity: 'warning',
      })
    }

    if (spec.actionType && match.action_type && match.action_type !== spec.actionType) {
      diffs.push({
        field: `${spec.name}.action_type`,
        expected: spec.actionType,
        actual: match.action_type,
        severity: 'warning',
      })
    }

    if (spec.actionClassification && String(match.action_classification ?? '') !== spec.actionClassification) {
      diffs.push({
        field: `${spec.name}.action_classification`,
        expected: spec.actionClassification,
        actual: String(match.action_classification ?? ''),
        severity: 'warning',
      })
    }

    if (typeof match.only_invocable_on_unresolved_incidents === 'boolean' && match.only_invocable_on_unresolved_incidents !== spec.onlyInvocableOnUnresolvedIncidents) {
      diffs.push({
        field: `${spec.name}.only_invocable_on_unresolved_incidents`,
        expected: spec.onlyInvocableOnUnresolvedIncidents,
        actual: match.only_invocable_on_unresolved_incidents,
        severity: 'warning',
      })
    }

    if (typeof match.allow_invocation_manually === 'boolean' && match.allow_invocation_manually !== spec.allowInvocationManually) {
      diffs.push({
        field: `${spec.name}.allow_invocation_manually`,
        expected: spec.allowInvocationManually,
        actual: match.allow_invocation_manually,
        severity: 'warning',
      })
    }

    if (
      typeof match.allow_invocation_from_event_orchestration === 'boolean' &&
      match.allow_invocation_from_event_orchestration !== spec.allowInvocationFromEventOrchestration
    ) {
      diffs.push({
        field: `${spec.name}.allow_invocation_from_event_orchestration`,
        expected: spec.allowInvocationFromEventOrchestration,
        actual: match.allow_invocation_from_event_orchestration,
        severity: 'warning',
      })
    }

    if (typeof match.map_to_all_services === 'boolean' && match.map_to_all_services !== spec.mapToAllServices) {
      diffs.push({
        field: `${spec.name}.map_to_all_services`,
        expected: spec.mapToAllServices,
        actual: match.map_to_all_services,
        severity: 'warning',
      })
    }

    const teamNames = parseNameList(spec.teamsJson, 'team').names ?? []
    const serviceNames = spec.mapToAllServices ? [] : parseNameList(spec.servicesJson, 'service').names ?? []
    if (teamNames.length === 0 && serviceNames.length === 0) continue

    const detail = await getAutomationAction(client, match.id)
    if (!detail) continue // best-effort: could not read association detail

    if (teamNames.length > 0) {
      if (teams === null) {
        try {
          teams = await listTeams(client)
        } catch {
          teams = []
        }
      }
      const currentTeamIds = liveTeamIds(detail)
      for (const teamName of teamNames) {
        const teamId = findTeamId(teams, teamName)
        if (!teamId) continue // best-effort: team no longer resolvable by name
        if (!currentTeamIds.has(teamId)) {
          diffs.push({ field: `${spec.name}.teams:${teamName}`, expected: 'associated', actual: 'not associated', severity: 'warning' })
        }
      }
    }

    if (serviceNames.length > 0) {
      if (services === null) {
        try {
          services = await listServices(client)
        } catch {
          services = []
        }
      }
      const currentServiceIds = liveServiceIds(detail)
      for (const serviceName of serviceNames) {
        const serviceId = findServiceId(services, serviceName)
        if (!serviceId) continue // best-effort: service no longer resolvable by name
        if (!currentServiceIds.has(serviceId)) {
          diffs.push({ field: `${spec.name}.services:${serviceName}`, expected: 'associated', actual: 'not associated', severity: 'warning' })
        }
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
