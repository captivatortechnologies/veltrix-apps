// =============================================================================
// Shared Xray POLICY domain module — the `/xray/api/v2/policies` CRUD-by-name
// plumbing and the ACTIONS schema, shared between the `security-policies` and
// `license-policies` config types (both are policies of a different `type`,
// against the exact same REST surface). CRITERIA is policy-type-specific and
// stays in each config type's own `_shared.ts`.
//
// Endpoints (verified — see config-types/security-policies/deploy.ts header
// for full citations):
//   GET    /xray/api/v2/policies            list all policies      (Read Policies role)
//   GET    /xray/api/v2/policies/{name}     read one policy         (Read Policies role)
//   POST   /xray/api/v2/policies            create a policy         (Manage Policies role)
//   PUT    /xray/api/v2/policies/{name}     replace a policy (full) (Manage Policies role)
//   DELETE /xray/api/v2/policies/{name}     delete a policy         (Manage Policies role)
//
// The ACTIONS block is confirmed IDENTICAL across policy types by JFrog's own
// Terraform provider docs — compare:
//   https://github.com/jfrog/terraform-provider-xray/blob/master/docs/resources/security_policy.md
//   https://github.com/jfrog/terraform-provider-xray/blob/master/docs/resources/license_policy.md
// =============================================================================

import type { XrayClient } from './xrayApi'
import { parseJsonObject, readBool, readOptionalNumber, readStringArray, looksLikeEmail } from './fields'

export const POLICIES_PATH = '/api/v2/policies'
export const policyPath = (name: string): string => `${POLICIES_PATH}/${encodeURIComponent(name)}`

// --- Wire shapes ---------------------------------------------------------------

export interface XrayBlockDownload {
  active?: boolean
  unscanned?: boolean
  grace_period_days?: number
}

/** The actions block — identical shape for `security`, `license` and `operational_risk` policies. */
export interface XrayPolicyActions {
  fail_build?: boolean
  build_failure_grace_period_in_days?: number
  block_download?: XrayBlockDownload
  block_release_bundle_distribution?: boolean
  block_release_bundle_promotion?: boolean
  notify_watch_recipients?: boolean
  notify_deployer?: boolean
  mails?: string[]
  webhooks?: string[]
  create_ticket_enabled?: boolean
  fail_pull_request?: boolean
  custom_severity?: string
  [extra: string]: unknown
}

export interface XrayPolicyRule<TCriteria = Record<string, unknown>> {
  name: string
  priority?: number
  criteria: TCriteria
  actions: XrayPolicyActions
}

export interface XrayPolicy<TCriteria = Record<string, unknown>> {
  name: string
  type: 'security' | 'license' | 'operational_risk'
  description?: string
  rules: XrayPolicyRule<TCriteria>[]
  // Read-only fields Xray populates on GET — never sent on write.
  author?: string
  created?: string
  modified?: string
  watches?: string[]
  project_key?: string
}

export interface PolicyRollbackEntry<TCriteria = Record<string, unknown>> {
  name: string
  existed: boolean
  /** The full prior policy body (read before the PUT) — used to restore an updated policy on rollback. */
  prior?: XrayPolicy<TCriteria>
}

// --- CRUD primitives -------------------------------------------------------------

export async function listPolicies<TCriteria = Record<string, unknown>>(client: XrayClient): Promise<XrayPolicy<TCriteria>[]> {
  return client.getJson<XrayPolicy<TCriteria>[]>(POLICIES_PATH)
}

export async function getPolicyByName<TCriteria = Record<string, unknown>>(client: XrayClient, name: string): Promise<XrayPolicy<TCriteria>> {
  return client.getJson<XrayPolicy<TCriteria>>(policyPath(name))
}

export async function createPolicy<TCriteria>(client: XrayClient, body: XrayPolicy<TCriteria>): Promise<unknown> {
  return client.postJson(POLICIES_PATH, body)
}

export async function putPolicy<TCriteria>(client: XrayClient, name: string, body: XrayPolicy<TCriteria>): Promise<unknown> {
  return client.putJson(policyPath(name), body)
}

export async function deletePolicy(client: XrayClient, name: string) {
  return client.deleteResource(policyPath(name))
}

/** The policy's logical identity: its name. Xray policy names are case-sensitive (they're a URL path segment). */
export function policyKey(name: string): string {
  return name.trim()
}

/** Find a live policy by name (exact match — Xray policy names are case-sensitive). */
export function findPolicyByName<TCriteria>(policies: XrayPolicy<TCriteria>[], name: string): XrayPolicy<TCriteria> | undefined {
  const key = policyKey(name)
  return policies.find((p) => policyKey(p.name ?? '') === key)
}

/** Strip the read-only fields Xray populates on GET before replaying a body on PUT. */
export function restorablePolicyBody<TCriteria>(
  prior: XrayPolicy<TCriteria>,
): Omit<XrayPolicy<TCriteria>, 'author' | 'created' | 'modified' | 'watches'> {
  const { author, created, modified, watches, ...rest } = prior
  return rest
}

/** A slash/backslash in a policy name breaks the `/policies/{name}` URL path. Returns an error message, or null. */
export function describePolicyNameError(name: string): string | null {
  if (/[/\\]/.test(name)) {
    return `Policy name "${name}" must not contain "/" or "\\" — it is used directly in the API URL.`
  }
  return null
}

// --- Shared ACTIONS: typed-field extraction, building, diffing -------------------

/** The flat canvas fields every policy type's "Actions" groups share verbatim. */
export interface PolicyActionFields {
  failBuild: boolean
  buildFailureGracePeriodDays?: number
  blockDownloadUnscanned: boolean
  blockDownloadActive: boolean
  blockReleaseBundleDistribution: boolean
  blockReleaseBundlePromotion: boolean
  notifyWatchRecipients: boolean
  notifyDeployer: boolean
  mails: string[]
  webhooks: string[]
  createTicketEnabled: boolean
  failPullRequest: boolean
  actionsJson: string
}

/** Read the shared action fields out of a canvas item's flat field record. */
export function extractPolicyActionFields(f: Record<string, unknown>): PolicyActionFields {
  return {
    failBuild: readBool(f.fail_build, false),
    buildFailureGracePeriodDays: readOptionalNumber(f.build_failure_grace_period_days),
    blockDownloadUnscanned: readBool(f.block_download_unscanned, false),
    blockDownloadActive: readBool(f.block_download_active, false),
    blockReleaseBundleDistribution: readBool(f.block_release_bundle_distribution, false),
    blockReleaseBundlePromotion: readBool(f.block_release_bundle_promotion, false),
    notifyWatchRecipients: readBool(f.notify_watch_recipients, false),
    notifyDeployer: readBool(f.notify_deployer, false),
    mails: readStringArray(f.mails),
    webhooks: readStringArray(f.webhooks),
    createTicketEnabled: readBool(f.create_ticket_enabled, false),
    failPullRequest: readBool(f.fail_pull_request, false),
    actionsJson: typeof f.actions_json === 'string' ? f.actions_json : '',
  }
}

/** Build an `actions` object from the shared typed fields + the `actions_json` escape valve (typed fields win). */
export function buildPolicyActions(fields: PolicyActionFields): XrayPolicyActions {
  const actions: XrayPolicyActions = {}
  if (fields.failBuild) actions.fail_build = true
  if (fields.buildFailureGracePeriodDays !== undefined) {
    actions.build_failure_grace_period_in_days = fields.buildFailureGracePeriodDays
  }
  if (fields.blockDownloadActive || fields.blockDownloadUnscanned) {
    actions.block_download = { active: fields.blockDownloadActive, unscanned: fields.blockDownloadUnscanned }
  }
  if (fields.blockReleaseBundleDistribution) actions.block_release_bundle_distribution = true
  if (fields.blockReleaseBundlePromotion) actions.block_release_bundle_promotion = true
  if (fields.notifyWatchRecipients) actions.notify_watch_recipients = true
  if (fields.notifyDeployer) actions.notify_deployer = true
  if (fields.mails.length > 0) actions.mails = fields.mails
  if (fields.webhooks.length > 0) actions.webhooks = fields.webhooks
  if (fields.createTicketEnabled) actions.create_ticket_enabled = true
  if (fields.failPullRequest) actions.fail_pull_request = true

  const extra = parseJsonObject(fields.actionsJson)
  return extra.ok ? { ...extra.value, ...actions } : actions
}

/** One validation finding against the shared action fields: a canvas field-key suffix, message, and code. */
export interface PolicyActionIssue {
  /** Appended to the caller's own `items[i]` prefix, e.g. "build_failure_grace_period_days". */
  fieldSuffix: string
  message: string
  code: string
}

/** Validate the shared action fields: grace period sanity + email shape. Field-agnostic — callers prefix `fieldSuffix`. */
export function validatePolicyActionFields(fields: PolicyActionFields): { errors: PolicyActionIssue[]; warnings: PolicyActionIssue[] } {
  const errors: PolicyActionIssue[] = []
  const warnings: PolicyActionIssue[] = []

  if (
    fields.buildFailureGracePeriodDays !== undefined &&
    (!Number.isInteger(fields.buildFailureGracePeriodDays) || fields.buildFailureGracePeriodDays < 0)
  ) {
    errors.push({
      fieldSuffix: 'build_failure_grace_period_days',
      message: 'Build failure grace period must be a non-negative whole number of days.',
      code: 'INVALID_GRACE_PERIOD',
    })
  }
  if (fields.buildFailureGracePeriodDays !== undefined && !fields.failBuild) {
    warnings.push({
      fieldSuffix: 'build_failure_grace_period_days',
      message: 'A build failure grace period has no effect unless "Fail build" is enabled.',
      code: 'GRACE_PERIOD_WITHOUT_FAIL_BUILD',
    })
  }
  fields.mails.forEach((mail, mi) => {
    if (!looksLikeEmail(mail)) {
      errors.push({ fieldSuffix: `mails[${mi}]`, message: `"${mail}" does not look like an email address.`, code: 'INVALID_EMAIL' })
    }
  })
  if (fields.createTicketEnabled) {
    warnings.push({
      fieldSuffix: 'create_ticket_enabled',
      message: 'Ticket creation requires a Jira integration already configured in Xray (Administration > Integrations).',
      code: 'TICKET_REQUIRES_JIRA',
    })
  }
  return { errors, warnings }
}

/** Compare two optional booleans, treating `undefined` as `false` (Xray omits false-valued flags). */
export function diffBool(field: string, desired: boolean | undefined, actual: boolean | undefined): { expected: string; actual: string } | null {
  const want = desired ?? false
  const have = actual ?? false
  return want === have ? null : { expected: String(want), actual: String(have) }
}

export type DiffPusher = (field: string, expected: unknown, actual: unknown, severity: 'info' | 'warning' | 'critical') => void

/** Diff the shared, policy-type-agnostic action fields this app manages. */
export function diffPolicyActions(label: string, desired: XrayPolicyActions, live: XrayPolicyActions, push: DiffPusher): void {
  const boolFields: Array<[string, keyof XrayPolicyActions]> = [
    ['fail_build', 'fail_build'],
    ['block_release_bundle_distribution', 'block_release_bundle_distribution'],
    ['block_release_bundle_promotion', 'block_release_bundle_promotion'],
    ['notify_watch_recipients', 'notify_watch_recipients'],
    ['notify_deployer', 'notify_deployer'],
    ['create_ticket_enabled', 'create_ticket_enabled'],
    ['fail_pull_request', 'fail_pull_request'],
  ]
  for (const [suffix, key] of boolFields) {
    const diff = diffBool(`${label}.${suffix}`, desired[key] as boolean | undefined, live[key] as boolean | undefined)
    if (diff) push(`${label}.${suffix}`, diff.expected, diff.actual, 'warning')
  }

  const desiredBlock = desired.block_download ?? {}
  const liveBlock = live.block_download ?? {}
  const active = diffBool(`${label}.block_download.active`, desiredBlock.active, liveBlock.active)
  if (active) push(`${label}.block_download.active`, active.expected, active.actual, 'warning')
  const unscanned = diffBool(`${label}.block_download.unscanned`, desiredBlock.unscanned, liveBlock.unscanned)
  if (unscanned) push(`${label}.block_download.unscanned`, unscanned.expected, unscanned.actual, 'warning')
}
