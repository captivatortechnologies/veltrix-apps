import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { resolveDomain, buildApiBase, fetchManagementToken, resolveClientCredentials } from '../../lib/auth0Api'
import { readString, stringSetsEqual } from '../../lib/fields'
import { findActionByName, parseDependencies, secretNames, TRIGGER_DEFAULT_VERSIONS } from './_shared'
import { getTriggerBindings, listActions } from './network'

/**
 * Drift for Auth0 actions: compare code, runtime, trigger id/version and
 * dependencies against the live action (matched by name); compare declared
 * secret NAMES only (Auth0 never returns secret values, so a value change can
 * never be detected — only an added/removed secret NAME can be); and compare
 * whether the action is actually bound to its trigger. Best-effort — an
 * unmatched action is skipped. Read-only: mint token → GET /actions/actions
 * (+ /actions/triggers/{id}/bindings).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const creds = resolveClientCredentials(credential)
  if (!creds) return { hasDrift: false, diffs }

  const domain = resolveDomain(component, connectivity, connectivityProvider)
  const base = buildApiBase(domain)

  let accessToken: string
  try {
    accessToken = (await fetchManagementToken({ domain, clientId: creds.clientId, clientSecret: creds.clientSecret })).accessToken
  } catch {
    return { hasDrift: false, diffs }
  }

  let live
  try {
    live = await listActions(base, accessToken)
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const name = readString(item.fields.name)
    const match = findActionByName(live, name)
    if (!match) continue

    const expectedCode = readString(item.fields.code)
    const actualCode = String(match.code ?? '')
    if (expectedCode !== actualCode) {
      diffs.push({ field: `${name}.code`, expected: '(declared code)', actual: '(live code differs)', severity: 'warning' })
    }

    const expectedRuntime = readString(item.fields.runtime) || 'node22'
    const actualRuntime = String(match.runtime ?? '')
    if (actualRuntime && expectedRuntime !== actualRuntime) {
      diffs.push({ field: `${name}.runtime`, expected: expectedRuntime, actual: actualRuntime, severity: 'warning' })
    }

    const expectedTriggerId = readString(item.fields.trigger_id)
    const expectedTriggerVersion = readString(item.fields.trigger_version) || TRIGGER_DEFAULT_VERSIONS[expectedTriggerId] || 'v1'
    const liveTrigger = (match.supported_triggers ?? [])[0]
    if (liveTrigger && (liveTrigger.id !== expectedTriggerId || liveTrigger.version !== expectedTriggerVersion)) {
      diffs.push({
        field: `${name}.supported_triggers`,
        expected: `${expectedTriggerId}@${expectedTriggerVersion}`,
        actual: `${liveTrigger.id}@${liveTrigger.version}`,
        severity: 'warning',
      })
    }

    const expectedDeps = parseDependencies(item.fields.dependencies).map((d) => `${d.name}@${d.version}`)
    const actualDeps = (match.dependencies ?? []).map((d) => `${d.name}@${d.version}`)
    if (!stringSetsEqual(expectedDeps, actualDeps)) {
      diffs.push({ field: `${name}.dependencies`, expected: expectedDeps, actual: actualDeps, severity: 'warning' })
    }

    const expectedSecretNames = secretNames(item.fields.secrets)
    const actualSecretNames = (match.secrets ?? []).map((s) => s.name)
    if (!stringSetsEqual(expectedSecretNames, actualSecretNames)) {
      diffs.push({ field: `${name}.secrets (names only)`, expected: expectedSecretNames, actual: actualSecretNames, severity: 'warning' })
    }

    if (match.id) {
      try {
        const bindings = await getTriggerBindings(base, expectedTriggerId, accessToken)
        const isBound = bindings.some((b) => b.ref.value === match.id)
        const expectedBound = item.fields.trigger_binding_enabled === undefined || item.fields.trigger_binding_enabled === true || item.fields.trigger_binding_enabled === 'true'
        if (isBound !== expectedBound) {
          diffs.push({ field: `${name}.trigger_binding_enabled`, expected: String(expectedBound), actual: String(isBound), severity: 'warning' })
        }
      } catch {
        // best-effort — a transient bindings read failure is not asserted as drift
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
