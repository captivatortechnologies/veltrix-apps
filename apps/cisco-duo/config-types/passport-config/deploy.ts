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
  extractPassportSpecs,
  normalizeGroupIds,
  type LivePassportConfig,
  type PassportSpec,
} from './validate'

const PATH = '/admin/v2/passport/config'

export interface PassportBody {
  enabled_status: string
  enabled_groups: string[]
  disabled_groups: string[]
  custom_supported_browsers: { macos: string[]; windows: string[] }
}

export interface PassportRollbackData {
  prior: PassportBody | null
}

/** Build the POST body from a canvas spec. */
export function buildPassportBody(spec: PassportSpec): PassportBody {
  return {
    enabled_status: spec.enabledStatus,
    enabled_groups: spec.enabledGroups,
    disabled_groups: spec.disabledGroups,
    custom_supported_browsers: { macos: spec.customBrowsersMacos, windows: spec.customBrowsersWindows },
  }
}

/** Normalize a live GET response into a POST-shaped body (ids, not group objects). */
export function normalizeLive(live: LivePassportConfig | null): PassportBody {
  return {
    enabled_status: typeof live?.enabled_status === 'string' ? live.enabled_status : 'disabled',
    enabled_groups: normalizeGroupIds(live?.enabled_groups),
    disabled_groups: normalizeGroupIds(live?.disabled_groups),
    custom_supported_browsers: {
      macos: Array.isArray(live?.custom_supported_browsers?.macos) ? live!.custom_supported_browsers!.macos! : [],
      windows: Array.isArray(live?.custom_supported_browsers?.windows) ? live!.custom_supported_browsers!.windows! : [],
    },
  }
}

/** GET the current Passport config; throws on a non-OK response. */
export async function readPassportConfig(client: DuoClient): Promise<LivePassportConfig | null> {
  const res = await client.getV5(PATH)
  if (!res.ok) throw new Error(duoErrorMessage(res))
  return (res.response as LivePassportConfig | null) ?? null
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readDuoSettings(ctx.settings)
  const cred = resolveDuoCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildDuoClient(cred, settings)

  const specs = extractPassportSpecs(ctx.canvas)
  if (specs.length === 0) return { success: false, message: 'No Passport configuration provided' }
  const spec = specs[0]

  try {
    const prior = normalizeLive(await readPassportConfig(client))
    const rollbackData: PassportRollbackData = { prior }

    const resp = await client.postV5(PATH, buildPassportBody(spec) as unknown as Record<string, unknown>)
    if (!resp.ok) {
      return { success: false, message: `Failed to update Passport config: ${duoErrorMessage(resp)}`, rollbackData }
    }

    return { success: true, message: `Passport config set to "${spec.enabledStatus}"`, rollbackData }
  } catch (error) {
    return { success: false, message: `Passport config deployment failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
