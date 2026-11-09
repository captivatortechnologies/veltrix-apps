import type { HealthCheck, HealthCheckResult, ValidationError, ValidationResult, ValidationWarning } from '@veltrixsecops/app-sdk'
import type { CompileIssue, PolicyException } from '../../lib/model/types'
import type { ExceptionDto } from '../../lib/db'

export function toErrors(prefix: string, issues: readonly CompileIssue[]): ValidationError[] {
  return issues.map((i) => ({ field: i.path ? `${prefix}.${i.path}` : prefix, message: i.message, code: i.code }))
}

export function toWarnings(prefix: string, issues: readonly CompileIssue[]): ValidationWarning[] {
  return toErrors(prefix, issues)
}

export function validationResult(errors: ValidationError[], warnings: ValidationWarning[]): ValidationResult {
  return { valid: errors.length === 0, errors, warnings }
}

export function scoreChecks(checks: HealthCheck[]): HealthCheckResult {
  const passed = checks.filter((c) => c.passed).length
  return {
    healthy: checks.length > 0 && passed === checks.length,
    score: checks.length > 0 ? Math.round((passed / checks.length) * 100) : 0,
    checks,
  }
}

export function check(name: string, passed: boolean, message: string): HealthCheck {
  return { name, passed, message }
}

export function toPolicyException(dto: ExceptionDto): PolicyException {
  return { policy: dto.policyName, resourceId: dto.resourceId, reason: dto.reason, approver: dto.approver, expiresAt: dto.expiresAt }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}
