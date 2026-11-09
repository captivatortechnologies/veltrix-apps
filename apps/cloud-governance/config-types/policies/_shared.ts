import type { ActionClass, Enforcement, GovernancePolicy } from '../../lib/model/types'

/** One policy's pre-deploy state, enough to restore or remove it on rollback. */
export interface PolicyRollbackEntry {
  name: string
  policyId: string
  existed: boolean
  previousVersion: number | null
  previousModel: GovernancePolicy | null
  previousCompiledYaml: string | null
  previousActionClass: ActionClass | null
  previousEnforcement: Enforcement | null
  previousCanvasId: string | null
  accountWasLinked: boolean
}

export interface PolicyRollbackData {
  componentId: string
  policies: PolicyRollbackEntry[]
}
