import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'
import { compilePolicy } from '../../lib/compiler'
import { validatePolicy } from '../../lib/model'
import type { CompileIssue, CompileResult, GovernancePolicy, PolicyException } from '../../lib/model/types'
import { readJsonArray, readList, readOptionalNumber, readOptionalString, readRecord, readString } from './readers'

export const REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-\d$/

export interface PolicyItem {
  model: Record<string, unknown>
  regions: string[]
  readIssues: CompileIssue[]
}

export interface PolicyEvaluation {
  item: PolicyItem
  validated: GovernancePolicy | null
  compile: CompileResult
  errors: CompileIssue[]
  warnings: CompileIssue[]
  ok: boolean
}

export interface EvaluateOptions {
  exceptions?: readonly PolicyException[]
  now?: Date
}

export function readPolicyItem(item: CanvasItemSnapshot): PolicyItem {
  const fields = item.fields ?? {}
  const filters = readJsonArray(fields, 'filters')
  const actions = readJsonArray(fields, 'actions')
  const regions = readList(fields, 'regions')
  const model: Record<string, unknown> = {
    name: readString(fields, 'name'),
    provider: 'aws',
    resource: readString(fields, 'resource'),
    filters: filters.value,
    actions: actions.value,
    enforcement: readString(fields, 'enforcement') || 'observe',
  }
  const description = readOptionalString(fields, 'description')
  if (description !== undefined) model.description = description
  for (const key of ['maxResources', 'maxResourcesPercent', 'gracePeriodDays']) {
    const value = readOptionalNumber(fields, key)
    if (value !== undefined) model[key] = value
  }
  const ownerTagKeys = readList(fields, 'ownerTagKeys')
  if (ownerTagKeys.length > 0) model.ownerTagKeys = ownerTagKeys
  const tags = readRecord(fields, 'tags')
  if (Object.keys(tags).length > 0) model.tags = tags

  const readIssues = [filters.issue, actions.issue].filter((i): i is CompileIssue => i !== null)
  regions.forEach((region, index) => {
    if (!REGION_PATTERN.test(region)) {
      readIssues.push({ path: `regions.${index}`, code: 'REGION_INVALID', message: `"${region}" is not an AWS region such as us-east-1` })
    }
  })
  return { model, regions, readIssues }
}

export function evaluatePolicyItem(canvasItem: CanvasItemSnapshot, options: EvaluateOptions = {}): PolicyEvaluation {
  const item = readPolicyItem(canvasItem)
  const compile = compilePolicy(item.model as unknown as GovernancePolicy, options)
  const errors = [...item.readIssues, ...compile.errors]
  return {
    item,
    validated: validatePolicy(item.model).value,
    compile,
    errors,
    warnings: compile.warnings,
    ok: errors.length === 0 && compile.ok,
  }
}

export function policyNamesOf(items: readonly CanvasItemSnapshot[]): string[] {
  return items.map((item) => readString(item.fields ?? {}, 'name')).filter((name) => name !== '')
}
