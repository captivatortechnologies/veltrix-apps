import driftDetect from '../driftDetect'
import { LOGON, driftContext, item, named, pvwaError, recordFetch, vendorCalls } from '../../lib/__tests__/fakePvwa'

const RULE = item('Rule 1', {
  rule_name: 'OnboardWindowsAdmins',
  rule_description: 'onboard discovered local admins',
  target_platform_id: 'WinServerLocal',
  target_safe_name: 'App-Prod',
  system_type_filter: 'Windows',
  machine_type_filter: 'Server',
  account_category_filter: 'Privileged',
  user_name_filter: 'Administrator',
})

const IN_SYNC = {
  RuleId: 31,
  RuleName: 'OnboardWindowsAdmins',
  RuleDescription: 'onboard discovered local admins',
  TargetPlatformId: 'WinServerLocal',
  TargetSafeName: 'App-Prod',
  SystemTypeFilter: 'Windows',
  MachineTypeFilter: 'Server',
  AccountCategoryFilter: 'Privileged',
  IsAdminIDFilter: false,
  UserNameFilter: 'Administrator',
  AddressFilter: '',
}

describe('CyberArk Onboarding Rules Drift Detect Handler', () => {
  it('reports no drift and calls nothing when no credential is configured', async () => {
    const fake = recordFetch([])
    try {
      const result = await driftDetect(driftContext([RULE], { credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('reports no drift when the live rule matches the deployed config', async () => {
    const fake = recordFetch([LOGON, named('AutomaticOnboardingRules', [IN_SYNC])])
    try {
      const result = await driftDetect(driftContext([RULE]))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(vendorCalls(fake.calls)).toHaveLength(1)
    } finally {
      fake.restore()
    }
  })

  it('reports a deleted rule as critical drift', async () => {
    const fake = recordFetch([LOGON, named('AutomaticOnboardingRules', [])])
    try {
      const result = await driftDetect(driftContext([RULE]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('OnboardWindowsAdmins')
      expect(result.diffs[0].severity).toBe('critical')
    } finally {
      fake.restore()
    }
  })

  it('reports a re-targeted safe as warning drift — the rule would onboard elsewhere', async () => {
    const fake = recordFetch([LOGON, named('AutomaticOnboardingRules', [{ ...IN_SYNC, TargetSafeName: 'Attacker-Safe' }])])
    try {
      const result = await driftDetect(driftContext([RULE]))

      const diff = result.diffs.find((d) => d.field === 'OnboardWindowsAdmins.target_safe_name')
      expect(diff?.expected).toBe('App-Prod')
      expect(diff?.actual).toBe('Attacker-Safe')
      expect(diff?.severity).toBe('warning')
    } finally {
      fake.restore()
    }
  })

  it('reports a widened account-category filter as informational drift', async () => {
    const fake = recordFetch([LOGON, named('AutomaticOnboardingRules', [{ ...IN_SYNC, AccountCategoryFilter: 'Any' }])])
    try {
      const result = await driftDetect(driftContext([RULE]))

      const diff = result.diffs.find((d) => d.field === 'OnboardWindowsAdmins.account_category_filter')
      expect(diff?.actual).toBe('Any')
      expect(diff?.severity).toBe('info')
    } finally {
      fake.restore()
    }
  })

  it('treats a filter PVWA omits as the empty value it was deployed with', async () => {
    const withoutAddress = { ...IN_SYNC }
    delete (withoutAddress as { AddressFilter?: string }).AddressFilter
    const fake = recordFetch([LOGON, named('AutomaticOnboardingRules', [withoutAddress])])
    try {
      const result = await driftDetect(driftContext([RULE]))

      expect(result.hasDrift).toBe(false)
    } finally {
      fake.restore()
    }
  })

  it('leaves rule diffs unattributed without spending an extra call on it', async () => {
    const fake = recordFetch([LOGON, named('AutomaticOnboardingRules', [{ ...IN_SYNC, TargetSafeName: 'Attacker-Safe' }])])
    try {
      const result = await driftDetect(driftContext([RULE]))

      expect(result.diffs[0].actor).toBeUndefined()
      expect(vendorCalls(fake.calls)).toHaveLength(1)
    } finally {
      fake.restore()
    }
  })

  it('reports PVWA being unreachable as critical drift rather than throwing', async () => {
    const fake = recordFetch([LOGON, pvwaError(500, 'PVWA is down')])
    try {
      const result = await driftDetect(driftContext([RULE]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('cyberark')
      expect(String(result.diffs[0].actual)).toMatch('PVWA is down')
    } finally {
      fake.restore()
    }
  })
})
