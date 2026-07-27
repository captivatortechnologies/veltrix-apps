import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  parseJson,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/graph'
import {
  extractAdminConsentRequestSpecs,
  parseArray,
  type AdminConsentRequestSpec,
  type LiveAdminConsentRequestPolicy,
} from './validate'

const PATH = '/policies/adminConsentRequestPolicy'
const SELECT = '?$select=isEnabled,notifyReviewers,remindersEnabled,requestDurationInDays,reviewers'

export interface RollbackEntry {
  existed: boolean
  prior?: Record<string, unknown>
}

/** Full-replace PUT body — every managed field is required. */
export function buildBody(spec: AdminConsentRequestSpec): Record<string, unknown> {
  return {
    isEnabled: spec.isEnabled,
    notifyReviewers: spec.notifyReviewers,
    remindersEnabled: spec.remindersEnabled,
    requestDurationInDays: spec.requestDurationInDays,
    reviewers: parseArray(spec.reviewers) ?? [],
  }
}

function snapshotLive(live: LiveAdminConsentRequestPolicy): Record<string, unknown> {
  return {
    isEnabled: live.isEnabled ?? false,
    notifyReviewers: live.notifyReviewers ?? false,
    remindersEnabled: live.remindersEnabled ?? false,
    requestDurationInDays: live.requestDurationInDays ?? 30,
    reviewers: live.reviewers ?? [],
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildGraphClient(cred, settings)

  const spec = extractAdminConsentRequestSpecs(ctx.canvas)[0]
  if (!spec) return { success: true, message: 'No admin consent request policy configured', rollbackData: { entries: [] } }

  const getResp = await client.get(`${PATH}${SELECT}`)
  if (!getResp.ok) {
    return { success: false, message: `Failed to read admin consent request policy: ${graphErrorMessage(getResp)}` }
  }
  const live = parseJson<LiveAdminConsentRequestPolicy>(getResp.body) ?? {}

  // Update is a full-replace PUT (not PATCH) — send the complete managed object.
  const resp = await client.put(PATH, buildBody(spec))
  if (!resp.ok) {
    return { success: false, message: `Failed to update admin consent request policy: ${graphErrorMessage(resp)}` }
  }

  const entries: RollbackEntry[] = [{ existed: true, prior: snapshotLive(live) }]
  return {
    success: true,
    message: `Admin consent requests ${spec.isEnabled ? 'enabled' : 'disabled'}`,
    rollbackData: { entries },
  }
}
