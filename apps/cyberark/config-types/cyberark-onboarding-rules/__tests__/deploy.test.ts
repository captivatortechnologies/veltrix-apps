import deploy from '../deploy'
import {
  API_URL,
  LOGON,
  LOGON_TOKEN,
  bodyOf,
  created,
  deployContext,
  isLogon,
  item,
  named,
  ok,
  pvwaError,
  recordFetch,
  vendorCalls,
} from '../../lib/__tests__/fakePvwa'

const RULE = item('Rule 1', {
  rule_name: 'OnboardWindowsAdmins',
  rule_description: 'onboard discovered local admins',
  target_platform_id: 'WinServerLocal',
  target_safe_name: 'App-Prod',
  system_type_filter: 'Windows',
  machine_type_filter: 'Server',
  account_category_filter: 'Privileged',
  user_name_filter: 'Administrator',
  user_name_method: 'Equals',
})

const LIVE_RULE = {
  RuleId: 31,
  RuleName: 'OnboardWindowsAdmins',
  RuleDescription: 'an older description',
  TargetPlatformId: 'WinServerLocal',
  TargetSafeName: 'App-Legacy',
  SystemTypeFilter: 'Windows',
  MachineTypeFilter: 'Any',
  AccountCategoryFilter: 'Any',
  UserNameMethod: 'Equals',
  AddressMethod: 'Equals',
}

describe('CyberArk Onboarding Rules Deploy Handler', () => {
  it('refuses without a credential instead of calling PVWA', async () => {
    const fake = recordFetch([])
    try {
      const result = await deploy(deployContext([RULE], { credential: null }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('logs on before the first resource call and sends the raw session token', async () => {
    const fake = recordFetch([LOGON, named('AutomaticOnboardingRules', []), created(), named('AutomaticOnboardingRules', [LIVE_RULE])])
    try {
      await deploy(deployContext([RULE]))

      expect(isLogon(fake.calls[0])).toBe(true)
      expect(fake.calls[0].authorization).toBeNull()
      expect(vendorCalls(fake.calls)[0].authorization).toBe(LOGON_TOKEN)
    } finally {
      fake.restore()
    }
  })

  it('creates a rule that does not exist yet and re-reads its RuleId for rollback', async () => {
    const fake = recordFetch([
      LOGON,
      named('AutomaticOnboardingRules', []),
      created(),
      named('AutomaticOnboardingRules', [LIVE_RULE]),
    ])
    try {
      const result = await deploy(deployContext([RULE]))

      const calls = vendorCalls(fake.calls)
      expect(calls[0].url).toBe(`${API_URL}/AutomaticOnboardingRules/`)

      const create = calls[1]
      expect(create.method).toBe('POST')
      expect(create.url).toBe(`${API_URL}/AutomaticOnboardingRules/`)
      expect(bodyOf(create)).toEqual({
        RuleName: 'OnboardWindowsAdmins',
        RuleDescription: 'onboard discovered local admins',
        TargetPlatformId: 'WinServerLocal',
        TargetSafeName: 'App-Prod',
        SystemTypeFilter: 'Windows',
        MachineTypeFilter: 'Server',
        AccountCategoryFilter: 'Privileged',
        IsAdminIDFilter: false,
        UserNameMethod: 'Equals',
        AddressMethod: 'Equals',
        UserNameFilter: 'Administrator',
      })

      // The Add response carries no RuleId, so it must be re-read by name.
      expect(calls[2].method).toBe('GET')
      expect(calls[2].url).toMatch('name=OnboardWindowsAdmins')

      expect(result.success).toBe(true)
      const rollbackData = result.rollbackData as {
        previousState: Array<{ existed: boolean; ruleId?: number }>
        createdRuleIds: number[]
      }
      expect(rollbackData.previousState[0].existed).toBe(false)
      expect(rollbackData.previousState[0].ruleId).toBe(31)
      expect(rollbackData.createdRuleIds).toEqual([31])
    } finally {
      fake.restore()
    }
  })

  it('replaces an existing rule in full and captures what it replaced', async () => {
    const fake = recordFetch([LOGON, named('AutomaticOnboardingRules', [LIVE_RULE]), ok()])
    try {
      const result = await deploy(deployContext([RULE]))

      const update = vendorCalls(fake.calls)[1]
      expect(update.method).toBe('PUT')
      expect(update.url).toBe(`${API_URL}/AutomaticOnboardingRules/31/`)

      const body = bodyOf(update) as Record<string, unknown>
      // A PUT is a FULL replace, so every managed field must be present — an
      // omitted one is reset to CyberArk's default.
      expect(body.RuleName).toBe('OnboardWindowsAdmins')
      expect(body.TargetSafeName).toBe('App-Prod')
      expect(body.MachineTypeFilter).toBe('Server')
      expect(body.AccountCategoryFilter).toBe('Privileged')

      const rollbackData = result.rollbackData as {
        previousState: Array<{ existed: boolean; ruleId?: number; prior?: { TargetSafeName?: string } }>
      }
      expect(rollbackData.previousState[0].existed).toBe(true)
      expect(rollbackData.previousState[0].ruleId).toBe(31)
      expect(rollbackData.previousState[0].prior?.TargetSafeName).toBe('App-Legacy')
    } finally {
      fake.restore()
    }
  })

  it('records a created rule with no RuleId rather than inventing one', async () => {
    const fake = recordFetch([LOGON, named('AutomaticOnboardingRules', []), created(), named('AutomaticOnboardingRules', [])])
    try {
      const result = await deploy(deployContext([RULE]))

      expect(result.success).toBe(true)
      const rollbackData = result.rollbackData as {
        previousState: Array<{ ruleId?: number }>
        createdRuleIds: number[]
      }
      expect(rollbackData.previousState[0].ruleId).toBeUndefined()
      expect(rollbackData.createdRuleIds).toEqual([])
    } finally {
      fake.restore()
    }
  })

  it('reports failure rather than throwing when PVWA rejects the create', async () => {
    const fake = recordFetch([LOGON, named('AutomaticOnboardingRules', []), pvwaError(400, 'Rule name is already in use')])
    try {
      const result = await deploy(deployContext([RULE]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch('Rule name is already in use')
      expect(result.message).toMatch(/0 of 1/)
    } finally {
      fake.restore()
    }
  })

  it('reports failure rather than throwing when the rule list itself fails', async () => {
    const fake = recordFetch([LOGON, pvwaError(403, 'Not authorized to read onboarding rules')])
    try {
      const result = await deploy(deployContext([RULE]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch('Not authorized to read onboarding rules')
    } finally {
      fake.restore()
    }
  })

  it('skips a rule that names no target safe rather than onboarding accounts nowhere', async () => {
    const fake = recordFetch([LOGON, named('AutomaticOnboardingRules', [])])
    try {
      const result = await deploy(
        deployContext([item('Rule 1', { rule_name: 'Broken', target_platform_id: 'WinServerLocal' })]),
      )

      expect(result.success).toBe(true)
      expect(vendorCalls(fake.calls)).toHaveLength(1)
    } finally {
      fake.restore()
    }
  })
})
