import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildGithubClient, parseJson } from '../../lib/githubApi'
import { desiredFromItem, parseRepository, buildDefaultSetupPatch, sortedLanguages, type DefaultSetupConfig } from './_shared'

/**
 * Drift for the code-scanning default-setup configuration: compare each
 * declared repository's state / query suite / threat model / languages /
 * runner against its live configuration. Read-only — GET the default-setup
 * endpoint. Best-effort: a repo that can't be read is skipped rather than
 * raising false drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const built = buildGithubClient(component.hostname, credential, settings ?? {})
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  for (const item of items) {
    const desired = desiredFromItem(item.fields)
    const parsed = parseRepository(desired.repository)
    if (!parsed) continue
    const { owner, repo } = parsed
    const fullName = `${owner}/${repo}`

    const res = await client.getCodeScanningDefaultSetup(owner, repo)
    if (!res.ok) continue // best-effort: can't read, assert no drift
    const live = parseJson<DefaultSetupConfig>(res.body) ?? {}
    const body = buildDefaultSetupPatch(desired)

    if (String(body.state) !== String(live.state ?? 'not-configured')) {
      diffs.push({ field: `${fullName}.state`, expected: body.state, actual: live.state ?? 'not-configured', severity: 'warning' })
    }
    if (desired.state !== 'configured') continue // rest only matters once configured

    if (String(body.query_suite ?? '') !== String(live.query_suite ?? '')) {
      diffs.push({ field: `${fullName}.query_suite`, expected: body.query_suite, actual: live.query_suite ?? null, severity: 'warning' })
    }
    if (String(body.threat_model ?? '') !== String(live.threat_model ?? '')) {
      diffs.push({ field: `${fullName}.threat_model`, expected: body.threat_model, actual: live.threat_model ?? null, severity: 'warning' })
    }
    if (desired.languages.length > 0 && sortedLanguages(desired.languages) !== sortedLanguages(live.languages)) {
      diffs.push({
        field: `${fullName}.languages`,
        expected: [...desired.languages].sort(),
        actual: [...(live.languages ?? [])].sort(),
        severity: 'warning',
      })
    }
    const expectedRunnerType = desired.runnerType || ''
    const actualRunnerType = live.runner_type || ''
    if (expectedRunnerType !== actualRunnerType) {
      diffs.push({ field: `${fullName}.runner_type`, expected: expectedRunnerType || '(default)', actual: actualRunnerType || '(default)', severity: 'warning' })
    }
    if (expectedRunnerType === 'labeled' && desired.runnerLabel !== (live.runner_label ?? '')) {
      diffs.push({ field: `${fullName}.runner_label`, expected: desired.runnerLabel, actual: live.runner_label ?? '', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
