export interface PackMemberRollback {
  policyName: string
  policyId: string
  wasLinked: boolean
}

export interface PackRollbackEntry {
  name: string
  members: PackMemberRollback[]
}

export interface PackRollbackData {
  componentId: string
  packs: PackRollbackEntry[]
}
