import type { CompileIssue } from '../model/types'
import { actionTypeOf } from '../model/actionClass'
import { classifyActionType } from '../model/awsResources'
import { hasOwn, isRecord, issue, joinPath, dedupeIssues } from '../model/issues'
import type { UnknownRecord } from '../model/issues'

export const DENY_CODES = {
  FILTER_VALUE_FROM: 'FILTER_VALUE_FROM',
  FILTER_TYPE_NOT_ALLOWED: 'FILTER_TYPE_NOT_ALLOWED',
  FILTER_INVALID: 'FILTER_INVALID',
  FILTER_TOO_DEEP: 'FILTER_TOO_DEEP',
  ACTION_WEBHOOK: 'ACTION_WEBHOOK',
  ACTION_INVOKE_LAMBDA: 'ACTION_INVOKE_LAMBDA',
  ACTION_INVOKE_SFN: 'ACTION_INVOKE_SFN',
  ACTION_NOTIFY: 'ACTION_NOTIFY',
  ACTION_LOGIC_APP: 'ACTION_LOGIC_APP',
  ACTION_UPDATE: 'ACTION_UPDATE',
  ACTION_INVALID: 'ACTION_INVALID',
  UNKNOWN_ACTION_TYPE: 'UNKNOWN_ACTION_TYPE',
  MODE_NOT_ALLOWED: 'MODE_NOT_ALLOWED',
  CONDITIONS_NOT_ALLOWED: 'CONDITIONS_NOT_ALLOWED',
  UNKNOWN_POLICY_KEY: 'UNKNOWN_POLICY_KEY',
  RESOURCE_NOT_ALLOWED: 'RESOURCE_NOT_ALLOWED',
} as const

export const MODEL_POLICY_KEYS: ReadonlySet<string> = new Set([
  'name',
  'description',
  'provider',
  'resource',
  'filters',
  'actions',
  'enforcement',
  'maxResources',
  'maxResourcesPercent',
  'ownerTagKeys',
  'gracePeriodDays',
  'tags',
])

export const EMITTED_POLICY_KEYS: ReadonlySet<string> = new Set([
  'name',
  'description',
  'resource',
  'filters',
  'actions',
  'tags',
  'max-resources',
  'max-resources-percent',
  'mode',
])

const DENIED_ACTIONS: Readonly<Record<string, { code: string; message: string }>> = {
  webhook: {
    code: DENY_CODES.ACTION_WEBHOOK,
    message: 'The webhook action sends resource data to arbitrary URLs and is not allowed',
  },
  'invoke-lambda': {
    code: DENY_CODES.ACTION_INVOKE_LAMBDA,
    message: 'The invoke-lambda action executes arbitrary customer code and is not allowed',
  },
  'invoke-sfn': {
    code: DENY_CODES.ACTION_INVOKE_SFN,
    message: 'The invoke-sfn action starts arbitrary state machines and is not allowed',
  },
  notify: {
    code: DENY_CODES.ACTION_NOTIFY,
    message: 'The notify action is not available yet; owner routing arrives in a later phase',
  },
  'logic-app': {
    code: DENY_CODES.ACTION_LOGIC_APP,
    message: 'The logic-app action runs arbitrary customer workflows and is not allowed',
  },
  update: {
    code: DENY_CODES.ACTION_UPDATE,
    message: 'The generic update action writes arbitrary ARM properties and is not allowed; use a typed action',
  },
}

const DENIED_FILTER_TYPES: ReadonlySet<string> = new Set(['event'])

const GROUP_KEYS = ['or', 'and', 'not'] as const
const VALUE_FROM_KEY = /^value[_-]from$/i
const MAX_DEPTH = 64

export interface ScanResult {
  issues: CompileIssue[]
  types: string[]
}

function scanValueFrom(value: unknown, path: string, depth: number, issues: CompileIssue[]): void {
  if (depth > MAX_DEPTH) {
    issues.push(issue(path, DENY_CODES.FILTER_TOO_DEEP, 'Nesting is too deep'))
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanValueFrom(item, joinPath(path, index), depth + 1, issues))
    return
  }
  if (!isRecord(value)) return
  for (const [key, child] of Object.entries(value)) {
    const childPath = joinPath(path, key)
    if (VALUE_FROM_KEY.test(key)) {
      issues.push(
        issue(
          childPath,
          DENY_CODES.FILTER_VALUE_FROM,
          'value_from reads http, https or file URIs at run time and is not allowed',
        ),
      )
    }
    scanValueFrom(child, childPath, depth + 1, issues)
  }
}

function checkFilterType(type: string, path: string, issues: CompileIssue[]): void {
  if (DENIED_FILTER_TYPES.has(type)) {
    issues.push(
      issue(path, DENY_CODES.FILTER_TYPE_NOT_ALLOWED, `Filter type "${type}" is not allowed in pull mode`),
    )
  }
}

function walkFilter(spec: unknown, path: string, depth: number, out: { issues: CompileIssue[]; types: Set<string> }): void {
  if (depth > MAX_DEPTH) {
    out.issues.push(issue(path, DENY_CODES.FILTER_TOO_DEEP, 'Filter nesting is too deep'))
    return
  }
  if (typeof spec === 'string' && spec.length > 0) {
    out.types.add(spec)
    checkFilterType(spec, path, out.issues)
    return
  }
  if (!isRecord(spec)) {
    out.issues.push(issue(path, DENY_CODES.FILTER_INVALID, 'A filter must be a type name or an object'))
    return
  }
  scanValueFrom(spec, path, depth, out.issues)
  const groups = GROUP_KEYS.filter((key) => hasOwn(spec, key))
  if (typeof spec.type === 'string' && spec.type.length > 0) {
    out.types.add(spec.type)
    checkFilterType(spec.type, joinPath(path, 'type'), out.issues)
  } else if (groups.length === 0) {
    out.issues.push(issue(path, DENY_CODES.FILTER_INVALID, 'A filter object needs a type or an or/and/not group'))
  }
  for (const key of groups) {
    const members = spec[key]
    const groupPath = joinPath(path, key)
    if (!Array.isArray(members)) {
      out.issues.push(issue(groupPath, DENY_CODES.FILTER_INVALID, `"${key}" must be an array of filters`))
      continue
    }
    members.forEach((member, index) => walkFilter(member, joinPath(groupPath, index), depth + 1, out))
  }
}

export function scanFilters(specs: unknown, basePath = 'filters'): ScanResult {
  const out = { issues: [] as CompileIssue[], types: new Set<string>() }
  if (Array.isArray(specs)) {
    specs.forEach((spec, index) => walkFilter(spec, joinPath(basePath, index), 0, out))
  }
  return { issues: dedupeIssues(out.issues), types: [...out.types].sort() }
}

export function scanActions(specs: unknown, basePath = 'actions'): ScanResult {
  const issues: CompileIssue[] = []
  const types = new Set<string>()
  if (Array.isArray(specs)) {
    specs.forEach((spec, index) => {
      const path = joinPath(basePath, index)
      const type = actionTypeOf(spec)
      if (type === null) {
        issues.push(issue(path, DENY_CODES.ACTION_INVALID, 'An action must be a type name or an object with a type'))
        return
      }
      types.add(type)
      const denied = hasOwn(DENIED_ACTIONS, type) ? DENIED_ACTIONS[type] : null
      if (denied) issues.push(issue(joinPath(path, 'type'), denied.code, denied.message))
      else if (classifyActionType(type) === null) {
        issues.push(
          issue(joinPath(path, 'type'), DENY_CODES.UNKNOWN_ACTION_TYPE, `Action type "${type}" is not in the allow-list`),
        )
      }
      if (isRecord(spec)) scanValueFrom(spec, path, 0, issues)
    })
  }
  return { issues: dedupeIssues(issues), types: [...types].sort() }
}

export function scanPolicyKeys(model: UnknownRecord): CompileIssue[] {
  const issues: CompileIssue[] = []
  for (const key of Object.keys(model)) {
    if (MODEL_POLICY_KEYS.has(key)) continue
    if (key === 'mode') {
      issues.push(issue(key, DENY_CODES.MODE_NOT_ALLOWED, 'The execution mode is set by the platform and cannot be authored'))
    } else if (key === 'conditions') {
      issues.push(issue(key, DENY_CODES.CONDITIONS_NOT_ALLOWED, 'Policy conditions are not allowed'))
    } else {
      issues.push(issue(key, DENY_CODES.UNKNOWN_POLICY_KEY, `Unknown policy key "${key}"`))
    }
  }
  return issues
}

export function scanEmittedKeys(document: UnknownRecord): CompileIssue[] {
  return Object.keys(document)
    .filter((key) => !EMITTED_POLICY_KEYS.has(key))
    .map((key) => issue(key, DENY_CODES.UNKNOWN_POLICY_KEY, `Key "${key}" must not be emitted`))
}
