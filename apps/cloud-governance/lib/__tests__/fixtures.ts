import type { ActionSpec, FilterSpec, GovernancePolicy, PolicyException } from '../model/types'

export function makePolicy(overrides: Partial<GovernancePolicy> = {}): GovernancePolicy {
  return {
    name: 'stopped-ec2-older-than-30-days',
    description: 'Mark stopped instances older than 30 days',
    provider: 'aws',
    resource: 'ec2',
    filters: [
      { type: 'value', key: 'State.Name', value: 'stopped' },
      { type: 'value', key: 'LaunchTime', value_type: 'age', value: 30, op: 'gt' },
    ],
    actions: [{ type: 'mark-for-op', op: 'stop', days: 7 }],
    enforcement: 'auto',
    ...overrides,
  }
}

export function makeException(overrides: Partial<PolicyException> = {}): PolicyException {
  return {
    policy: 'stopped-ec2-older-than-30-days',
    resourceId: 'i-0abc123',
    reason: 'Legacy build host',
    approver: 'sec-lead@example.com',
    expiresAt: '2030-01-01',
    ...overrides,
  }
}

export const NESTINGS: ReadonlyArray<readonly [string, (inner: FilterSpec) => FilterSpec[], string]> = [
  ['top level', (inner) => [inner], 'filters.0'],
  ['inside or', (inner) => [{ or: [{ type: 'value', key: 'a', value: 1 }, inner] }], 'filters.0.or.1'],
  ['inside and', (inner) => [{ and: [inner] }], 'filters.0.and.0'],
  ['inside not', (inner) => [{ not: [inner] }], 'filters.0.not.0'],
  ['deeply nested', (inner) => [{ or: [{ and: [{ not: [inner] }] }] }], 'filters.0.or.0.and.0.not.0'],
]

export function actionPolicy(actions: ActionSpec[]): GovernancePolicy {
  return makePolicy({ actions })
}
