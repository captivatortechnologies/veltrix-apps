import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildDuoClient,
  duoErrorMessage,
  readDuoSettings,
  resolveDuoCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type DuoClient,
} from '../../lib/duo'
import {
  buildSettingsParams,
  extractAccountSettingsSpecs,
  serializeLiveSetting,
  SETTING_FIELDS,
} from './validate'

const PATH = '/admin/v1/settings'

export interface AccountSettingsRollbackData {
  /** Prior form values for exactly the keys this deploy applied, replayed on rollback. */
  priorParams: Record<string, string>
  appliedKeys: string[]
}

/** GET the current global settings object; throws on a non-OK response. */
export async function readSettings(client: DuoClient): Promise<Record<string, unknown>> {
  const res = await client.get(PATH)
  if (!res.ok) throw new Error(duoErrorMessage(res))
  return (res.response as Record<string, unknown> | null) ?? {}
}

/** Capture the prior serialized values for the keys we are about to write. */
export function priorParamsFor(live: Record<string, unknown>, appliedKeys: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const def of SETTING_FIELDS) {
    if (!appliedKeys.includes(def.key)) continue
    if (!(def.key in live)) continue
    out[def.key] = serializeLiveSetting(def, live[def.key])
  }
  return out
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readDuoSettings(ctx.settings)
  const cred = resolveDuoCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildDuoClient(cred, settings)

  const specs = extractAccountSettingsSpecs(ctx.canvas)
  if (specs.length === 0) return { success: false, message: 'No account settings provided' }
  const spec = specs[0]

  const params = buildSettingsParams(spec)
  const appliedKeys = Object.keys(params)

  if (appliedKeys.length === 0) {
    // Nothing to manage — a clean no-op (Duo rejects an empty POST).
    return { success: true, message: 'No account settings declared — nothing to apply', rollbackData: { priorParams: {}, appliedKeys: [] } }
  }

  try {
    const live = await readSettings(client)
    const rollbackData: AccountSettingsRollbackData = { priorParams: priorParamsFor(live, appliedKeys), appliedKeys }

    const resp = await client.post(PATH, params)
    if (!resp.ok) {
      return { success: false, message: `Failed to update account settings: ${duoErrorMessage(resp)}`, rollbackData }
    }

    return { success: true, message: `Updated ${appliedKeys.length} account setting(s): ${appliedKeys.join(', ')}`, rollbackData }
  } catch (error) {
    return { success: false, message: `Account settings deployment failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
