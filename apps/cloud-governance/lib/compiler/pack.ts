import type { ActionClass, CompileIssue, CompileResult, GovernancePolicy, PolicyPack } from '../model/types'
import { maxActionClass } from '../model/actionClass'
import { hasOwn, issue } from '../model/issues'
import { validatePack } from '../model/validate'
import { compilePolicy, emptyResult } from './compilePolicy'
import type { CompileOptions } from './compilePolicy'
import { toYaml } from './yaml'

function prefixIssues(prefix: string, issues: CompileIssue[]): CompileIssue[] {
  return issues.map((i) => ({ ...i, path: i.path ? `${prefix}.${i.path}` : prefix }))
}

function unionSorted(lists: string[][]): string[] {
  return [...new Set(lists.flat())].sort()
}

export function compilePack(
  pack: PolicyPack,
  policiesByName: Readonly<Record<string, GovernancePolicy>>,
  options: CompileOptions = {},
): CompileResult {
  const { value, errors: packErrors } = validatePack(pack)
  if (!value) return emptyResult(packErrors)

  const errors: CompileIssue[] = []
  const warnings: CompileIssue[] = []
  const documents: Array<Record<string, unknown>> = []
  const classes: ActionClass[] = []
  const filterTypes: string[][] = []
  const actionTypes: string[][] = []

  value.policies.forEach((name, index) => {
    const member = hasOwn(policiesByName, name) ? policiesByName[name] : undefined
    const path = `policies.${index}`
    if (!member) {
      errors.push(issue(path, 'PACK_MEMBER_MISSING', `Policy "${name}" is not available to compile`))
      return
    }
    const result = compilePolicy(member, options)
    errors.push(...prefixIssues(`${path}.${name}`, result.errors))
    warnings.push(...prefixIssues(`${path}.${name}`, result.warnings))
    if (!result.ok || !result.document) return
    documents.push(...result.document.policies)
    classes.push(result.actionClass)
    filterTypes.push(result.usedTypes.filters)
    actionTypes.push(result.usedTypes.actions)
  })

  if (errors.length > 0) return emptyResult(errors, warnings)
  const document = { policies: documents }
  return {
    ok: true,
    document,
    yaml: toYaml(document),
    errors: [],
    warnings,
    actionClass: maxActionClass(classes),
    usedTypes: { filters: unionSorted(filterTypes), actions: unionSorted(actionTypes) },
  }
}
