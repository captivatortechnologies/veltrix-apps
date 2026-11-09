import type { CompileIssue, FilterGroup, GovernancePolicy, PolicyException } from '../model/types'
import { resourceIdKey } from '../model/awsResources'
import { isRecord, issue } from '../model/issues'
import { validateException } from '../model/validate'

export interface ExceptionOutcome {
  filters: FilterGroup[]
  errors: CompileIssue[]
  warnings: CompileIssue[]
}

export function buildExceptionFilters(
  policy: Pick<GovernancePolicy, 'name' | 'resource' | 'provider'>,
  exceptions: readonly PolicyException[],
  now: Date,
): ExceptionOutcome {
  const outcome: ExceptionOutcome = { filters: [], errors: [], warnings: [] }
  const idKey = resourceIdKey(policy.resource, policy.provider)
  exceptions.forEach((candidate, index) => {
    const path = `exceptions.${index}`
    if (isRecord(candidate) && candidate.policy !== policy.name) return
    const { value, errors } = validateException(candidate)
    if (!value) {
      outcome.errors.push(...errors.map((e) => issue(e.path ? `${path}.${e.path}` : path, e.code, e.message)))
      return
    }
    if (Date.parse(value.expiresAt) <= now.getTime()) {
      outcome.warnings.push(
        issue(path, 'EXCEPTION_EXPIRED', `Exception for ${value.resourceId} expired at ${value.expiresAt} and is not applied`),
      )
      return
    }
    if (policy.provider === 'aws' && /^arn:/i.test(value.resourceId) && !/arn$/i.test(idKey)) {
      outcome.warnings.push(
        issue(path, 'EXCEPTION_ARN_UNMATCHED', `${policy.resource} resources are matched on ${idKey}; an ARN will not exclude anything`),
      )
    }
    outcome.filters.push({ not: [{ type: 'value', key: idKey, value: value.resourceId }] })
  })
  return outcome
}
