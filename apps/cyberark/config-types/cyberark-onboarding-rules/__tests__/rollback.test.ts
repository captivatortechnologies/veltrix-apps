import rollback from '../rollback'
import type { OnboardingRuleRollbackEntry } from '../deploy'
import {
  API_URL,
  LOGON,
  bodyOf,
  ok,
  pvwaError,
  recordFetch,
  rollbackContext,
  vendorCalls,
} from '../../lib/__tests__/fakePvwa'

const CREATED: OnboardingRuleRollbackEntry = {
  key: 'onboardwindowsadmins',
  label: 'OnboardWindowsAdmins',
  existed: false,
  ruleId: 31,
}

const UPDATED: OnboardingRuleRollbackEntry = {
  key: 'onboardunixroot',
  label: 'OnboardUnixRoot',
  existed: true,
  ruleId: 32,
  prior: {
    RuleId: 32,
    RuleName: 'OnboardUnixRoot',
    RuleDescription: 'the description it had before',
    TargetPlatformId: 'UnixSSH',
    TargetSafeName: 'App-Legacy',
    SystemTypeFilter: 'Unix',
    MachineTypeFilter: 'Server',
    AccountCategoryFilter: 'Privileged',
    UserNameFilter: 'root',
    UserNameMethod: 'Equals',
    AddressMethod: 'Begins',
  },
}

describe('CyberArk Onboarding Rules Rollback Handler', () => {
  it('refuses without a credential instead of calling PVWA', async () => {
    const fake = recordFetch([])
    try {
      const result = await rollback(rollbackContext({ previousState: [CREATED] }, { credential: null }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('refuses when the deployment recorded no previous state', async () => {
    const fake = recordFetch([])
    try {
      const result = await rollback(rollbackContext({ previousState: [] }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/No previous state/)
      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('deletes a rule this deploy created', async () => {
    const fake = recordFetch([LOGON, ok()])
    try {
      const result = await rollback(rollbackContext({ previousState: [CREATED] }))

      const calls = vendorCalls(fake.calls)
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('DELETE')
      expect(calls[0].url).toBe(`${API_URL}/AutomaticOnboardingRules/31/`)
      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })

  it('restores every prior field of a rule this deploy replaced', async () => {
    const fake = recordFetch([LOGON, ok()])
    try {
      const result = await rollback(rollbackContext({ previousState: [UPDATED] }))

      const restore = vendorCalls(fake.calls)[0]
      expect(restore.method).toBe('PUT')
      expect(restore.url).toBe(`${API_URL}/AutomaticOnboardingRules/32/`)
      expect(bodyOf(restore)).toEqual({
        RuleName: 'OnboardUnixRoot',
        RuleDescription: 'the description it had before',
        TargetPlatformId: 'UnixSSH',
        TargetSafeName: 'App-Legacy',
        SystemTypeFilter: 'Unix',
        MachineTypeFilter: 'Server',
        AccountCategoryFilter: 'Privileged',
        IsAdminIDFilter: false,
        UserNameMethod: 'Equals',
        AddressMethod: 'Begins',
        UserNameFilter: 'root',
      })
      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })

  it('unwinds in reverse deploy order', async () => {
    const fake = recordFetch([LOGON, ok(), ok()])
    try {
      await rollback(rollbackContext({ previousState: [CREATED, UPDATED] }))

      const calls = vendorCalls(fake.calls)
      expect(calls[0].url).toBe(`${API_URL}/AutomaticOnboardingRules/32/`)
      expect(calls[1].url).toBe(`${API_URL}/AutomaticOnboardingRules/31/`)
    } finally {
      fake.restore()
    }
  })

  it('treats an already-deleted rule (404) as successfully rolled back', async () => {
    const fake = recordFetch([LOGON, pvwaError(404, 'Rule not found')])
    try {
      const result = await rollback(rollbackContext({ previousState: [CREATED] }))

      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })

  it('reports failure rather than throwing when PVWA rejects the restore', async () => {
    const fake = recordFetch([LOGON, pvwaError(403, 'Not authorized to update onboarding rules')])
    try {
      const result = await rollback(rollbackContext({ previousState: [UPDATED] }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch('Not authorized to update onboarding rules')
    } finally {
      fake.restore()
    }
  })

  it('skips a created rule whose RuleId was never resolved', async () => {
    const fake = recordFetch([LOGON])
    try {
      const result = await rollback(rollbackContext({ previousState: [{ ...CREATED, ruleId: undefined }] }))

      expect(vendorCalls(fake.calls)).toHaveLength(0)
      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })
})
