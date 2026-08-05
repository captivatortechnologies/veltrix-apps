import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSplunkUrl, buildAuthHeader, splunkFetch } from '../../lib/splunkApi'
import { auditClientFromBase, attachDriftActor, veltrixActorLogins } from '../lib/splunkAudit'
import { AUTH_TOKENS_PATH } from './deploy'

/**
 * Detect drift between deployed API access token canvas config and the live
 * token state on the Splunk component (matched by username + audience).
 *
 * Severity policy:
 *  - missing token / unreachable component ......... critical
 *  - token disabled while canvas expects enabled ... critical (API access stopped)
 *  - token enabled while canvas expects disabled .... warning
 *  - type / expiresOn / notBefore differ from live .. warning (immutable —
 *    the next deploy recreates the token rather than editing it in place)
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, deployedConfig } = ctx
  const diffs: DriftDiff[] = []

  if (!credential || (!connectivity && !connectivityProvider)) return { hasDrift: false, diffs: [] }

  const baseUrl = buildSplunkUrl(component, connectivity, connectivityProvider)
  const auth = buildAuthHeader(credential)

  const auditClient = auditClientFromBase(baseUrl, auth)
  const excludeLogins = veltrixActorLogins(credential)

  for (const section of deployedConfig.sections) {
    const fields = section.fields
    const username = fields.username as string
    const audience = fields.audience as string
    if (!username || !audience) continue

    const label = `${username}·${audience}`
    const objectDiffs: DriftDiff[] = []
    try {
      const res = await splunkFetch(
        `${baseUrl}${AUTH_TOKENS_PATH}?username=${encodeURIComponent(username)}&count=0&output_mode=json`,
        { method: 'GET', headers: auth, timeoutMs: 15_000 },
      )

      if (!res.ok) {
        objectDiffs.push({ field: label, expected: 'reachable', actual: `HTTP ${res.status}`, severity: 'critical' })
      } else {
        const data = JSON.parse(await res.text())
        const entries: Array<{ content?: Record<string, unknown> }> = data?.entry ?? []
        const match = entries.find((e) => e.content?.audience === audience)?.content

        if (!match) {
          objectDiffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        } else {
          const desiredEnabled = fields.enabled !== false
          const liveEnabled = String(match.status ?? 'enabled').toLowerCase() !== 'disabled'
          if (liveEnabled !== desiredEnabled) {
            objectDiffs.push({
              field: `${label}.enabled`,
              expected: desiredEnabled,
              actual: liveEnabled,
              severity: desiredEnabled ? 'critical' : 'warning',
            })
          }

          const desiredType = typeof fields.tokenType === 'string' && fields.tokenType ? fields.tokenType : 'static'
          if (String(match.type ?? '') !== desiredType) {
            objectDiffs.push({ field: `${label}.tokenType`, expected: desiredType, actual: match.type, severity: 'warning' })
          }
          if (typeof fields.expiresOn === 'string' && fields.expiresOn && String(match.expires_on ?? '') !== fields.expiresOn) {
            objectDiffs.push({ field: `${label}.expiresOn`, expected: fields.expiresOn, actual: match.expires_on, severity: 'warning' })
          }
          if (typeof fields.notBefore === 'string' && fields.notBefore && String(match.not_before ?? '') !== fields.notBefore) {
            objectDiffs.push({ field: `${label}.notBefore`, expected: fields.notBefore, actual: match.not_before, severity: 'warning' })
          }
        }
      }
    } catch (error) {
      objectDiffs.push({
        field: label,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }

    if (objectDiffs.length > 0) {
      await attachDriftActor(auditClient, objectDiffs, { objectName: username, excludeActorLogins: excludeLogins })
      diffs.push(...objectDiffs)
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
