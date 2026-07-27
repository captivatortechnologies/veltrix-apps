import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, parseJson, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import {
  canonical,
  extractAdminConsentRequestSpecs,
  parseArray,
  type LiveAdminConsentRequestPolicy,
} from './validate'

const PATH = '/policies/adminConsentRequestPolicy'
const SELECT = '?$select=isEnabled,notifyReviewers,remindersEnabled,requestDurationInDays,reviewers'

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildGraphClient(cred, settings)

  const spec = extractAdminConsentRequestSpecs(ctx.deployedConfig)[0]
  if (!spec) return { hasDrift: false, diffs: [] }

  const resp = await client.get(`${PATH}${SELECT}`)
  if (!resp.ok) return { hasDrift: false, diffs: [] }
  const live = parseJson<LiveAdminConsentRequestPolicy>(resp.body) ?? {}

  const diffs: DriftResult['diffs'] = []
  const scalar = (field: string, want: string, actual: string) => {
    if (want !== actual) diffs.push({ field, expected: want, actual, severity: 'warning' })
  }

  scalar('isEnabled', String(spec.isEnabled), String(live.isEnabled === true))
  scalar('notifyReviewers', String(spec.notifyReviewers), String(live.notifyReviewers === true))
  scalar('remindersEnabled', String(spec.remindersEnabled), String(live.remindersEnabled === true))
  scalar('requestDurationInDays', String(spec.requestDurationInDays), String(live.requestDurationInDays ?? 0))

  const wantReviewers = canonical(parseArray(spec.reviewers) ?? [])
  const liveReviewers = canonical(live.reviewers ?? [])
  if (wantReviewers !== liveReviewers) {
    diffs.push({ field: 'reviewers', expected: wantReviewers, actual: liveReviewers, severity: 'warning' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
