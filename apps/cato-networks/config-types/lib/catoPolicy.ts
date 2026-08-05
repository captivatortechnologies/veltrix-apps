// =============================================================================
// Shared "policy" pipeline for every Cato rule-based / section-based
// configuration type (Internet Firewall, WAN Firewall, Application Control,
// TLS Inspection, Anti-Malware File Hash - rules; Internet/WAN Firewall -
// sections).
//
// Every one of these policy areas exposes the SAME shape under
// `policy(accountId: ID!) { <policyArea> { ... } }` on both Query and
// Mutation (verified against cato_api.graphqls, the schema Cato's own
// `cato-go-sdk` / `terraform-provider-cato` are generated from):
//   - addRule / updateRule / removeRule / moveRule   (rule CRUD + ordering)
//   - addSection / updateSection / removeSection / moveSection (section CRUD + ordering)
//   - publishPolicyRevision / discardPolicyRevision  (the staged config workflow)
// `moveRule` (`PolicyMoveRuleInput`) and every section mutation
// (`PolicyAddSectionInput` / `PolicyUpdateSectionInput` / `PolicyRemoveSectionInput`
// / `PolicyMoveSectionInput`) share IDENTICAL input types across every policy
// area - only `addRule` / `updateRule` / `removeRule` take a policy-area-prefixed
// input type (e.g. `InternetFirewallAddRuleInput`) because the rule's own body
// differs per area. Every rule type otherwise implements the schema's `IPolicyRule`
// interface (id, name, description, enabled, index, section{id,name}), so listing
// and matching rules by name is fully generic.
//
// STAGED CONFIG MODEL: every write lands in the calling admin's own PRIVATE
// draft revision (auto-created on first write when none exists - confirmed by
// every mutation's `revision` input being OPTIONAL in the schema, and by
// Cato's own Terraform provider never creating one explicitly for a normal
// apply). Nothing is live until `publishPolicyRevision` is called - this is
// Cato's equivalent of Zscaler ZIA's activate() / Panorama's commit(). Deploy
// therefore performs every add/update/remove/move, then calls
// publishPolicyRevision ONCE at the end (see runRulePolicyDeploy /
// runSectionPolicyDeploy below). If nothing changed, Cato returns
// `status: FAILURE` with `errorCode: PolicyRevisionNotFound` - the official
// Terraform provider (policy_publish_application_control.go) treats that
// specific code as a no-op, not an error; this client does the same.
//
// Rollback: if publish never succeeded, `discardPolicyRevision` cleanly
// discards the whole staged (unpublished) draft. If publish DID succeed
// (rollback invoked later, e.g. after a failed health check), there is
// nothing left to discard - rollback instead replays the captured prior
// state (restore updated rules/sections, delete created ones) and publishes
// again, exactly like zscaler's DLP dictionary rollback.
//
// A rare, documented race - "Cannot reorder policy while other active
// revisions exist" / `reorderPolicyBlockedByActiveSessions` - is retried with
// backoff (mirroring terraform-provider-cato's
// `withPolicyRevisionConflictRetry`).
// =============================================================================

import type {
  CanvasItemSnapshot,
  CanvasSnapshot,
  ComponentConfigStatus,
  ConfigStatus,
  DeployContext,
  DeployResult,
  DriftContext,
  DriftDiff,
  DriftResult,
  HealthCheckContext,
  HealthCheckResult,
  PipelineContext,
  RollbackContext,
  RollbackResult,
} from '@veltrixsecops/app-sdk'
import { buildCatoClient, graphqlErrorMessage, responseError, type CatoClient } from '../../lib/cato'

export const COMPONENT_TYPE = 'cato-account'

const CONCURRENT_REVISION_MAX_ATTEMPTS = 4
const CONCURRENT_REVISION_BACKOFF_MS = 5_000
const CONCURRENT_REVISION_PATTERNS = [/reorderPolicyBlockedByActiveSessions/i, /active revisions exist/i]

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function looksLikeConcurrentRevisionConflict(message: string): boolean {
  return CONCURRENT_REVISION_PATTERNS.some((re) => re.test(message))
}

/** Retry `fn` when it rejects with a concurrent-policy-revision conflict message. */
export async function withPolicyRevisionConflictRetry<T>(fn: () => Promise<T>, checkMessage: (result: T) => string | null): Promise<T> {
  let last: T | undefined
  for (let attempt = 1; attempt <= CONCURRENT_REVISION_MAX_ATTEMPTS; attempt++) {
    last = await fn()
    const message = checkMessage(last)
    if (!message || !looksLikeConcurrentRevisionConflict(message)) return last
    if (attempt === CONCURRENT_REVISION_MAX_ATTEMPTS) return last
    await sleep(CONCURRENT_REVISION_BACKOFF_MS * attempt)
  }
  return last as T
}

// --- Generic rule/section node shapes (IPolicyRule / PolicySectionPayload) ---

export interface PolicySectionRef {
  id: string
  name: string
}

/** Fields common to every Cato policy rule type (the `IPolicyRule` interface). */
export interface PolicyRuleNode {
  id: string
  name: string
  description?: string | null
  enabled: boolean
  index: number
  section?: PolicySectionRef | null
}

export const RULE_NODE_FIELDS = 'id name description enabled index section { id name }'
export const SECTION_NODE_FIELDS = 'id name'

export interface PolicyMutationErrorNode {
  errorCode?: string | null
  errorMessage?: string | null
}

export interface PolicyMutationEnvelope<TNode> {
  status: 'SUCCESS' | 'FAILURE'
  errors: PolicyMutationErrorNode[]
  node: TNode | null
}

function formatPolicyErrors(errors: PolicyMutationErrorNode[] | undefined): string {
  if (!errors || errors.length === 0) return 'unknown policy error'
  return errors.map((e) => e.errorMessage || e.errorCode || 'error').join('; ')
}

/** The one policy error code Cato returns when there is no staged draft to publish/discard - a no-op, not a failure. */
export const POLICY_REVISION_NOT_FOUND = 'PolicyRevisionNotFound'

// --- Query/mutation document builders ----------------------------------------

/**
 * Read the full rule + section list for one policy area, e.g.:
 *   query { policy(accountId: $accountId) { internetFirewall { policy {
 *     rules { rule { id name description enabled index section { id name } } }
 *     sections { section { id name } }
 *   } } } }
 */
export function listPolicyDoc(policyArea: string): string {
  return `query ListPolicy($accountId: ID!) {
    policy(accountId: $accountId) {
      ${policyArea} {
        policy {
          rules { rule { ${RULE_NODE_FIELDS} } }
          sections { section { ${SECTION_NODE_FIELDS} } }
        }
      }
    }
  }`
}

export interface ListPolicyResult {
  rules: PolicyRuleNode[]
  sections: PolicySectionRef[]
}

export function parseListPolicyResult(policyArea: string, data: unknown): ListPolicyResult {
  const node = (data as Record<string, any> | null)?.policy?.[policyArea]?.policy
  const rules: PolicyRuleNode[] = Array.isArray(node?.rules)
    ? node.rules.map((r: any) => r?.rule).filter((r: unknown): r is PolicyRuleNode => !!r)
    : []
  const sections: PolicySectionRef[] = Array.isArray(node?.sections)
    ? node.sections.map((s: any) => s?.section).filter((s: unknown): s is PolicySectionRef => !!s)
    : []
  return { rules, sections }
}

export async function listPolicy(client: CatoClient, policyArea: string): Promise<{ ok: true; value: ListPolicyResult } | { ok: false; error: string }> {
  const res = await client.graphql(listPolicyDoc(policyArea), { accountId: client.accountId })
  const err = responseError(res)
  if (err) return { ok: false, error: err }
  return { ok: true, value: parseListPolicyResult(policyArea, res.data) }
}

/** Build a rule add/update/remove mutation scoped to one policy area. `mutationField` is addRule|updateRule|removeRule. */
export function ruleMutationDoc(policyArea: string, mutationField: 'addRule' | 'updateRule' | 'removeRule', inputType: string): string {
  return `mutation RuleMutation($accountId: ID!, $input: ${inputType}) {
    policy(accountId: $accountId) {
      ${policyArea} {
        ${mutationField}(input: $input) {
          status
          errors { errorCode errorMessage }
          rule { rule { ${RULE_NODE_FIELDS} } }
        }
      }
    }
  }`
}

export function moveRuleDoc(policyArea: string): string {
  return `mutation MoveRule($accountId: ID!, $input: PolicyMoveRuleInput!) {
    policy(accountId: $accountId) {
      ${policyArea} {
        moveRule(input: $input) {
          status
          errors { errorCode errorMessage }
        }
      }
    }
  }`
}

export function sectionMutationDoc(
  policyArea: string,
  mutationField: 'addSection' | 'updateSection' | 'removeSection',
  inputType: string,
): string {
  return `mutation SectionMutation($accountId: ID!, $input: ${inputType}) {
    policy(accountId: $accountId) {
      ${policyArea} {
        ${mutationField}(input: $input) {
          status
          errors { errorCode errorMessage }
          section { section { ${SECTION_NODE_FIELDS} } }
        }
      }
    }
  }`
}

export function moveSectionDoc(policyArea: string): string {
  return `mutation MoveSection($accountId: ID!, $input: PolicyMoveSectionInput!) {
    policy(accountId: $accountId) {
      ${policyArea} {
        moveSection(input: $input) {
          status
          errors { errorCode errorMessage }
        }
      }
    }
  }`
}

export function publishPolicyRevisionDoc(policyArea: string): string {
  return `mutation Publish($accountId: ID!) {
    policy(accountId: $accountId) {
      ${policyArea} {
        publishPolicyRevision {
          status
          errors { errorCode errorMessage }
        }
      }
    }
  }`
}

export function discardPolicyRevisionDoc(policyArea: string): string {
  return `mutation Discard($accountId: ID!) {
    policy(accountId: $accountId) {
      ${policyArea} {
        discardPolicyRevision {
          status
          errors { errorCode errorMessage }
        }
      }
    }
  }`
}

/** Extract a mutation payload envelope nested at `policy.<policyArea>.<mutationField>`. */
export function extractEnvelope<TNode>(
  data: unknown,
  policyArea: string,
  mutationField: string,
  unwrapNode: (raw: any) => TNode | null,
): PolicyMutationEnvelope<TNode> {
  const raw = (data as Record<string, any> | null)?.policy?.[policyArea]?.[mutationField]
  return {
    status: raw?.status === 'SUCCESS' ? 'SUCCESS' : 'FAILURE',
    errors: Array.isArray(raw?.errors) ? raw.errors : [],
    node: raw ? unwrapNode(raw) : null,
  }
}

export const unwrapRule = (raw: any): PolicyRuleNode | null => raw?.rule?.rule ?? null
export const unwrapSection = (raw: any): PolicySectionRef | null => raw?.section?.section ?? null

/** Publish the staged draft; `PolicyRevisionNotFound` (nothing staged) is treated as a no-op success. */
export async function publishPolicy(client: CatoClient, policyArea: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await client.graphql(publishPolicyRevisionDoc(policyArea), { accountId: client.accountId })
  const transportErr = responseError(res)
  if (transportErr) return { ok: false, error: transportErr }
  const env = extractEnvelope(res.data, policyArea, 'publishPolicyRevision', () => null)
  if (env.status === 'SUCCESS') return { ok: true }
  if (env.errors.some((e) => e.errorCode === POLICY_REVISION_NOT_FOUND)) return { ok: true }
  return { ok: false, error: formatPolicyErrors(env.errors) }
}

/** Discard the staged (unpublished) draft entirely - used when a deploy fails before publish. */
export async function discardPolicy(client: CatoClient, policyArea: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await client.graphql(discardPolicyRevisionDoc(policyArea), { accountId: client.accountId })
  const transportErr = responseError(res)
  if (transportErr) return { ok: false, error: transportErr }
  const env = extractEnvelope(res.data, policyArea, 'discardPolicyRevision', () => null)
  if (env.status === 'SUCCESS') return { ok: true }
  if (env.errors.some((e) => e.errorCode === POLICY_REVISION_NOT_FOUND)) return { ok: true }
  return { ok: false, error: formatPolicyErrors(env.errors) }
}

// --- Position helpers (PolicyRulePositionInput / PolicySectionPositionInput) -

export type RulePosition = 'FIRST_IN_SECTION' | 'LAST_IN_SECTION' | 'BEFORE_RULE' | 'AFTER_RULE'
export type SectionPosition = 'LAST_IN_POLICY' | 'BEFORE_SECTION' | 'AFTER_SECTION'

/** Resolve a rule's `at`/`to` position input. `ref` is a rule id for BEFORE/AFTER_RULE, a section id for FIRST/LAST_IN_SECTION. */
export function resolveRulePosition(
  position: RulePosition,
  sectionId: string | null,
  siblingRuleId: string | null,
): { position: RulePosition; ref?: string } {
  if (position === 'BEFORE_RULE' || position === 'AFTER_RULE') {
    return { position, ref: siblingRuleId ?? undefined }
  }
  return { position, ref: sectionId ?? undefined }
}

export function resolveSectionPosition(position: SectionPosition, siblingSectionId: string | null): { position: SectionPosition; ref?: string } {
  if (position === 'LAST_IN_POLICY') return { position }
  return { position, ref: siblingSectionId ?? undefined }
}

// --- JSON escape-hatch parsing -----------------------------------------------

/** Parse a canvas JSON-object field; returns null for blank input, undefined (via throw) is never used - invalid JSON returns `undefined`. */
export function parseJsonObject(raw: unknown): Record<string, unknown> | null | undefined {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) return null
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

// --- Shared getStatus (identical across every Cato config type) --------------

export async function runGetStatus(ctx: PipelineContext): Promise<ConfigStatus> {
  const { canvas, platform } = ctx
  const latestDeployment = await platform.getLatestDeployment(canvas.canvasId, { status: 'SUCCEEDED' })
  if (!latestDeployment) {
    return { deployed: false, version: String(canvas.version), lastDeployedAt: '', componentStatuses: [] }
  }
  const components = await platform.listComponents({ types: [COMPONENT_TYPE] })
  const componentStatuses: ComponentConfigStatus[] = components.map((comp) => ({
    componentId: comp.id,
    hostname: comp.hostname,
    deployed: true,
    version: String(canvas.version),
    lastDeployedAt: latestDeployment.completedAt || '',
    healthy: latestDeployment.healthScore != null ? latestDeployment.healthScore >= 80 : undefined,
    healthScore: latestDeployment.healthScore ?? undefined,
  }))
  return {
    deployed: true,
    version: String(canvas.version),
    lastDeployedAt: latestDeployment.completedAt || latestDeployment.startedAt,
    componentStatuses,
  }
}

/** Shared health check: list the policy - proves the API key, account id and policy-area reachability together. */
export async function runPolicyHealthCheck(ctx: HealthCheckContext, policyArea: string, typeLabel: string): Promise<HealthCheckResult> {
  const built = buildCatoClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'cato_credential', passed: false, message: built.error }] }
  }
  const started = Date.now()
  const result = await listPolicy(built.client, policyArea)
  const latencyMs = Date.now() - started
  if (!result.ok) {
    return {
      healthy: false,
      score: 0,
      checks: [{ name: 'cato_reachable', passed: false, message: `Failed to read ${typeLabel} policy: ${result.error}`, latencyMs }],
    }
  }
  return {
    healthy: true,
    score: 100,
    checks: [
      {
        name: 'cato_reachable',
        passed: true,
        message: `Connected to Cato account ${built.accountId} (${result.value.rules.length} rule(s), ${result.value.sections.length} section(s))`,
        latencyMs,
      },
    ],
  }
}

export function items(canvas: CanvasSnapshot): CanvasItemSnapshot[] {
  return canvas.items ?? canvas.sections ?? []
}

export type { DeployContext, DeployResult, DriftContext, DriftDiff, DriftResult, RollbackContext, RollbackResult }
