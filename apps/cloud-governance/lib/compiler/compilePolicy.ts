import type {
  ActionClass,
  ActionSpec,
  CompileIssue,
  CompileResult,
  CompiledPolicyDocument,
  FilterSpec,
  GovernancePolicy,
  PolicyException,
} from '../model/types'
import { actionTypeOf, classifyActions } from '../model/actionClass'
import { providerPrefix } from '../model/awsResources'
import { dedupeIssues, isRecord, issue } from '../model/issues'
import { validatePolicy } from '../model/validate'
import { scanActions, scanEmittedKeys, scanFilters } from './denyList'
import { buildExceptionFilters } from './exceptions'
import { toYaml } from './yaml'

export const DEFAULT_MAX_RESOURCES = 100
export const DEFAULT_MAX_RESOURCES_PERCENT = 10
export const TAG_POLICY = 'veltrix:policy'
export const TAG_ENFORCEMENT = 'veltrix:enforcement'

export interface CompileOptions {
  exceptions?: readonly PolicyException[]
  now?: Date
}

export function emptyResult(errors: CompileIssue[], warnings: CompileIssue[] = []): CompileResult {
  return {
    ok: false,
    document: null,
    yaml: null,
    errors: dedupeIssues(errors),
    warnings,
    actionClass: 'none',
    usedTypes: { filters: [], actions: [] },
  }
}

function policyTags(policy: GovernancePolicy): string[] {
  const merged: Record<string, string> = {
    ...(policy.tags ?? {}),
    [TAG_POLICY]: policy.name,
    [TAG_ENFORCEMENT]: policy.enforcement,
  }
  return Object.entries(merged).map(([key, value]) => `${key}=${value}`)
}

function buildDocument(
  policy: GovernancePolicy,
  filters: FilterSpec[],
  actions: GovernancePolicy['actions'],
): Record<string, unknown> {
  const document: Record<string, unknown> = { name: policy.name }
  if (policy.description) document.description = policy.description
  document.resource = `${providerPrefix(policy.provider)}${policy.resource}`
  document.mode = { type: 'pull' }
  document['max-resources'] = policy.maxResources ?? DEFAULT_MAX_RESOURCES
  document['max-resources-percent'] = policy.maxResourcesPercent ?? DEFAULT_MAX_RESOURCES_PERCENT
  document.tags = policyTags(policy)
  if (filters.length > 0) document.filters = filters
  if (actions.length > 0) document.actions = actions
  return document
}

const MARK_FOR_OP = 'mark-for-op'

function applyGracePeriod(actions: ActionSpec[], days: number | undefined): { actions: ActionSpec[]; used: boolean } {
  let used = false
  const result = actions.map((action): ActionSpec => {
    if (actionTypeOf(action) !== MARK_FOR_OP) return action
    used = true
    if (days === undefined) return action
    if (typeof action === 'string') return { type: MARK_FOR_OP, days }
    return action.days === undefined ? { ...action, days } : action
  })
  return { actions: result, used }
}

export function compilePolicy(model: GovernancePolicy, options: CompileOptions = {}): CompileResult {
  const { value: policy, errors: shapeErrors } = validatePolicy(model)
  const source: Record<string, unknown> = isRecord(model) ? model : {}
  const filterScan = scanFilters(source.filters)
  const actionScan = scanActions(source.actions)
  const errors = [...shapeErrors, ...filterScan.issues, ...actionScan.issues]
  if (!policy || errors.length > 0) return emptyResult(errors)

  const exceptions = buildExceptionFilters(policy, options.exceptions ?? [], options.now ?? new Date())
  if (exceptions.errors.length > 0) return emptyResult(exceptions.errors, exceptions.warnings)

  const actionClass: ActionClass = classifyActions(policy.actions)
  const stripped = policy.enforcement === 'observe' || policy.enforcement === 'notify'
  const filters: FilterSpec[] = [...policy.filters, ...exceptions.filters]
  const grace = applyGracePeriod(policy.actions, policy.gracePeriodDays)
  const actions = stripped ? [] : grace.actions
  const warnings = [...exceptions.warnings]
  if (policy.gracePeriodDays !== undefined && !grace.used) {
    warnings.push(issue('gracePeriodDays', 'GRACE_PERIOD_UNUSED', 'gracePeriodDays has no effect without a mark-for-op action'))
  }
  const document = buildDocument(policy, filters, actions)

  const emittedKeyErrors = scanEmittedKeys(document)
  if (emittedKeyErrors.length > 0) return emptyResult(emittedKeyErrors, warnings)

  const compiled: CompiledPolicyDocument = { policies: [document] }
  return {
    ok: true,
    document: compiled,
    yaml: toYaml(compiled),
    errors: [],
    warnings,
    actionClass,
    usedTypes: { filters: scanFilters(filters).types, actions: scanActions(actions).types },
  }
}
