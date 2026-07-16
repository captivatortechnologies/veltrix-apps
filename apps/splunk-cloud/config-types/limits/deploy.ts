import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  acsErrorMessage,
  acsRequest,
  parseJson,
  readAcsSettings,
  resolveAcsToken,
  resolveStackName,
  type AcsRequestOptions,
} from '../../lib/acs'
import { extractLimitSpecs } from './validate'

export interface LimitRollbackEntry {
  stanza: string
  setting: string
  /** Value before this deployment (ACS returns it as a string), or null if unset/unreadable. */
  previousValue: string | null
  /** Integer value this deployment set. */
  newValue: number
}

/** One stanza block from the GET /limits response: { "Stanza": ..., "Values": {...} }. */
interface LiveLimitStanza {
  Stanza: string
  Values?: Record<string, string>
}

/** GET the full editable limits.conf state, keyed as stanza → setting → value. */
async function readLiveLimits(acs: AcsRequestOptions): Promise<Map<string, Map<string, string>>> {
  const res = await acsRequest(acs, 'GET', '/limits')
  if (res.status !== 200) {
    throw new Error(`Failed to read limits: ${acsErrorMessage(res)}`)
  }
  const parsed = parseJson<LiveLimitStanza[]>(res.body) ?? []
  const byStanza = new Map<string, Map<string, string>>()
  for (const entry of parsed) {
    const values = new Map<string, string>()
    for (const [name, val] of Object.entries(entry.Values ?? {})) {
      values.set(name, String(val))
    }
    byStanza.set(entry.Stanza, values)
  }
  return byStanza
}

/**
 * Deploy limits.conf settings to a Splunk Cloud stack via the ACS API.
 *
 * For each declared setting the handler reads the live value and, when it
 * differs, writes the declared value:
 *   - GET  /limits — read all editable settings (captures prior values)
 *   - POST /limits/{stanza} — set the declared setting via { settings: { ... } }
 * Prior values are captured in rollbackData so rollback can restore them.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const token = resolveAcsToken(ctx.credential)
  if (!token) {
    return {
      success: false,
      message:
        'No ACS token available — store the Splunk Cloud JWT (sc_admin) in the credential "API token" field',
    }
  }

  const settings = readAcsSettings(ctx.settings)
  const stack = resolveStackName(ctx.component.hostname)
  const acs: AcsRequestOptions = {
    baseUrl: settings.baseUrl,
    stack,
    token,
    timeoutMs: settings.timeoutMs,
  }

  const specs = extractLimitSpecs(ctx.canvas).filter((s) => s.stanza && s.setting && s.value !== null)
  const rollbackState: LimitRollbackEntry[] = []
  const summary: string[] = []

  try {
    const live = await readLiveLimits(acs)

    for (const spec of specs) {
      const value = spec.value as number
      const previousValue = live.get(spec.stanza)?.get(spec.setting) ?? null
      const desired = String(value)

      // Idempotent: only POST when the live value actually differs.
      if (previousValue !== desired) {
        const res = await acsRequest(acs, 'POST', `/limits/${encodeURIComponent(spec.stanza)}`, {
          settings: { [spec.setting]: value },
        })
        // ACS applies limits asynchronously — a successful edit returns 202.
        if (res.status !== 200 && res.status !== 202) {
          throw new Error(`Failed to set ${spec.stanza}.${spec.setting}: ${acsErrorMessage(res)}`)
        }
      }

      rollbackState.push({ stanza: spec.stanza, setting: spec.setting, previousValue, newValue: value })
      summary.push(`${spec.stanza}.${spec.setting}: ${previousValue ?? '—'}→${value}`)
    }

    return {
      success: true,
      message: `Applied ${specs.length} limits.conf setting(s) on stack "${stack}" (${summary.join(', ')})`,
      artifacts: {
        stack,
        experience: settings.experience,
        limits: specs.map((s) => `${s.stanza}.${s.setting}`),
        changes: rollbackState,
      },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `limits.conf deployment to stack "${stack}" failed after ${rollbackState.length} of ${specs.length} setting(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { stack, changes: rollbackState },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState },
    }
  }
}
