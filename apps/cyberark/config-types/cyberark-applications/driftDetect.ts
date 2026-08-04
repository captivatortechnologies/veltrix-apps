import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCyberArkClient } from '../../lib/cyberark'
import { listAuthMethods, mapApplications } from './deploy'
import { appKey, authMethodSignature, extractApplicationSpecs, parseAuthMethods } from './validate'

/**
 * Detect drift between the deployed application configuration and the live
 * PVWA. Re-finds each declared application by AppID (missing = critical) and
 * diffs its authentication methods. Top-level field drift (Description,
 * Location, access window, business owner) is reported as INFORMATIONAL ONLY
 * — there is no verified update endpoint for these (see deploy.ts), so a
 * mismatch cannot be auto-corrected by a re-deploy; it is surfaced so an
 * operator knows to reconcile it in the PVWA UI (or delete + recreate).
 *
 * Applications carry no creator/modifier metadata over this API, so diffs are
 * reported without an actor (mirrors safe members / onboarding rules).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildCyberArkClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractApplicationSpecs(ctx.deployedConfig).filter((s) => s.appId)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const byKey = await mapApplications(client)

    for (const spec of specs) {
      const found = byKey.get(appKey(spec))
      if (!found) {
        diffs.push({ field: spec.appId, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const compare = (field: string, expected: string, actual: string | undefined) => {
        if ((actual ?? '') !== expected && expected !== '') {
          diffs.push({ field: `${spec.appId}.${field} (not auto-correctable — no update endpoint)`, expected, actual: actual ?? 'not set', severity: 'info' })
        }
      }
      compare('description', spec.description, found.Description)
      compare('location', spec.location, found.Location)

      const methods = parseAuthMethods(spec.authMethodsJson)
      if (methods.value) {
        const live = await listAuthMethods(client, spec.appId)
        const liveSignatures = new Set(live.map((m) => authMethodSignature({ authType: m.AuthType ?? '', authValue: m.AuthValue, issuer: m.Issuer, subject: m.Subject, subjectAlternativeName: m.SubjectAlternativeName })))
        const desiredSignatures = new Set(methods.value.map((m) => authMethodSignature(m)))
        for (const m of methods.value) {
          if (!liveSignatures.has(authMethodSignature(m))) {
            diffs.push({ field: `${spec.appId}.authentication_methods`, expected: `${m.authType}:${m.authValue ?? '(cert attrs)'}`, actual: 'missing', severity: 'warning' })
          }
        }
        for (const m of live) {
          const sig = authMethodSignature({ authType: m.AuthType ?? '', authValue: m.AuthValue, issuer: m.Issuer, subject: m.Subject, subjectAlternativeName: m.SubjectAlternativeName })
          if (!desiredSignatures.has(sig)) {
            diffs.push({ field: `${spec.appId}.authentication_methods`, expected: 'not declared', actual: `${m.AuthType ?? 'unknown'}:${m.AuthValue ?? '(cert attrs)'}`, severity: 'warning' })
          }
        }
      }
    }
  } catch (error) {
    diffs.push({
      field: 'cyberark',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  await client.logoff()
  return { hasDrift: diffs.length > 0, diffs }
}
