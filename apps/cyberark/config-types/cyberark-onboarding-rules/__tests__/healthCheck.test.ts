import healthCheck from '../healthCheck'
import { API_URL, LOGON, healthContext, item, named, pvwaError, recordFetch, vendorCalls } from '../../lib/__tests__/fakePvwa'

const RULES = [
  item('Rule 1', { rule_name: 'OnboardWindowsAdmins', target_platform_id: 'WinServerLocal', target_safe_name: 'App-Prod' }),
  item('Rule 2', { rule_name: 'OnboardUnixRoot', target_platform_id: 'UnixSSH', target_safe_name: 'App-Prod' }),
]

describe('CyberArk Onboarding Rules Health Check Handler', () => {
  it('fails closed without a credential instead of calling PVWA', async () => {
    const fake = recordFetch([])
    try {
      const result = await healthCheck(healthContext(RULES, { credential: null }))

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks[0].name).toBe('cyberark_credential')
      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('scores 100 when every declared rule is present', async () => {
    const fake = recordFetch([
      LOGON,
      named('AutomaticOnboardingRules', [
        { RuleId: 31, RuleName: 'OnboardWindowsAdmins' },
        { RuleId: 32, RuleName: 'OnboardUnixRoot' },
      ]),
    ])
    try {
      const result = await healthCheck(healthContext(RULES))

      expect(result.healthy).toBe(true)
      expect(result.score).toBe(100)
      expect(result.checks).toHaveLength(3)
      expect(vendorCalls(fake.calls)[0].url).toBe(`${API_URL}/AutomaticOnboardingRules/`)
    } finally {
      fake.restore()
    }
  })

  it('reports the specific rule that has gone missing', async () => {
    const fake = recordFetch([LOGON, named('AutomaticOnboardingRules', [{ RuleId: 31, RuleName: 'OnboardWindowsAdmins' }])])
    try {
      const result = await healthCheck(healthContext(RULES))

      expect(result.healthy).toBe(false)
      const missing = result.checks.find((c) => c.name === 'rule:OnboardUnixRoot')
      expect(missing?.passed).toBe(false)
      expect(missing?.message).toMatch('missing')
    } finally {
      fake.restore()
    }
  })

  it('reports a failed reachability check rather than throwing when PVWA errors', async () => {
    const fake = recordFetch([LOGON, pvwaError(500, 'PVWA is down')])
    try {
      const result = await healthCheck(healthContext(RULES))

      expect(result.healthy).toBe(false)
      expect(result.checks).toHaveLength(1)
      expect(result.checks[0].message).toMatch('PVWA is down')
    } finally {
      fake.restore()
    }
  })
})
