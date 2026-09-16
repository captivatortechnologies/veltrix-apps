import deploy from '../deploy'
import {
  API_URL,
  LEGACY_URL,
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

const APP = item('Application 1', {
  app_id: 'AAM-Payments',
  description: 'payments service CCP identity',
  location: '\\Applications',
  authentication_methods:
    '[{"authType":"machineAddress","authValue":"10.0.0.7"},{"authType":"osUser","authValue":"CORP\\\\svc_pay"}]',
})

const LIVE_APP = { AppID: 'AAM-Payments', Description: 'payments service CCP identity', Location: '\\Applications' }

describe('CyberArk Applications Deploy Handler', () => {
  it('refuses without a credential instead of calling PVWA', async () => {
    const fake = recordFetch([])
    try {
      const result = await deploy(deployContext([APP], { credential: null }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('logs on against the Gen2 API, then works on the classic Web Services base', async () => {
    const fake = recordFetch([LOGON, named('application', []), created(), named('authentication', []), created(), created()])
    try {
      await deploy(deployContext([APP]))

      expect(isLogon(fake.calls[0])).toBe(true)
      expect(fake.calls[0].url).toMatch(`${API_URL}/auth/`)
      expect(fake.calls[0].authorization).toBeNull()

      // The classic Applications endpoints predate /PasswordVault/API and share
      // the same session token.
      for (const call of vendorCalls(fake.calls)) {
        expect(call.url).toMatch(LEGACY_URL)
        expect(call.authorization).toBe(LOGON_TOKEN)
      }
    } finally {
      fake.restore()
    }
  })

  it('creates an application that does not exist yet and adds its auth methods', async () => {
    const fake = recordFetch([LOGON, named('application', []), created(), named('authentication', []), created(), created()])
    try {
      const result = await deploy(deployContext([APP]))

      const calls = vendorCalls(fake.calls)
      expect(calls[0].url).toBe(`${LEGACY_URL}/Applications/`)

      expect(calls[1].method).toBe('POST')
      expect(calls[1].url).toBe(`${LEGACY_URL}/Applications/`)
      expect(bodyOf(calls[1])).toEqual({
        application: {
          AppID: 'AAM-Payments',
          Description: 'payments service CCP identity',
          Location: '\\Applications',
          Disabled: false,
        },
      })

      expect(calls[2].url).toBe(`${LEGACY_URL}/Applications/AAM-Payments/Authentications/`)
      expect(calls[3].method).toBe('POST')
      expect(bodyOf(calls[3])).toEqual({ authentication: { AuthType: 'machineAddress', AuthValue: '10.0.0.7' } })
      expect(bodyOf(calls[4])).toEqual({ authentication: { AuthType: 'osUser', AuthValue: 'CORP\\svc_pay' } })

      expect(result.success).toBe(true)
      const rollbackData = result.rollbackData as { previousState: Array<{ existed: boolean; priorAuthMethods: unknown[] }> }
      expect(rollbackData.previousState[0].existed).toBe(false)
      expect(rollbackData.previousState[0].priorAuthMethods).toEqual([])
    } finally {
      fake.restore()
    }
  })

  it('leaves an existing application’s own fields alone and says so', async () => {
    const fake = recordFetch([
      LOGON,
      named('application', [{ ...LIVE_APP, Description: 'something an admin typed' }]),
      named('authentication', []),
      created(),
      created(),
    ])
    try {
      const result = await deploy(deployContext([APP]))

      const calls = vendorCalls(fake.calls)
      expect(calls.some((c) => c.method === 'POST' && c.url === `${LEGACY_URL}/Applications/`)).toBe(false)

      const notes = (result.artifacts as { notes: string[] }).notes
      expect(notes).toHaveLength(1)
      expect(notes[0]).toMatch('no verified update endpoint')
      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })

  it('removes an authentication method that is no longer declared', async () => {
    const fake = recordFetch([
      LOGON,
      named('application', [LIVE_APP]),
      named('authentication', [
        { AuthType: 'machineAddress', AuthValue: '10.0.0.7' },
        { AuthType: 'machineAddress', AuthValue: '10.0.0.99', authID: '5' },
      ]),
      created(),
      ok(),
    ])
    try {
      const result = await deploy(deployContext([APP]))

      const calls = vendorCalls(fake.calls)
      // Only the osUser method is missing, so exactly one add...
      expect(bodyOf(calls[2])).toEqual({ authentication: { AuthType: 'osUser', AuthValue: 'CORP\\svc_pay' } })
      // ...and the undeclared machineAddress is deleted by its id.
      expect(calls[3].method).toBe('DELETE')
      expect(calls[3].url).toBe(`${LEGACY_URL}/Applications/AAM-Payments/Authentications/5`)

      const rollbackData = result.rollbackData as { previousState: Array<{ priorAuthMethods: unknown[] }> }
      expect(rollbackData.previousState[0].priorAuthMethods).toHaveLength(2)
    } finally {
      fake.restore()
    }
  })

  it('leaves an undeclared method in place when PVWA gave it no addressable id', async () => {
    const fake = recordFetch([
      LOGON,
      named('application', [LIVE_APP]),
      named('authentication', [
        { AuthType: 'machineAddress', AuthValue: '10.0.0.7' },
        { AuthType: 'osUser', AuthValue: 'CORP\\svc_pay' },
        { AuthType: 'hash', AuthValue: 'abc123' },
      ]),
    ])
    try {
      const result = await deploy(deployContext([APP]))

      // Nothing addressable to delete — guessing an id would be worse.
      expect(vendorCalls(fake.calls).some((c) => c.method === 'DELETE')).toBe(false)
      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })

  it('reports failure rather than throwing when PVWA rejects the create', async () => {
    const fake = recordFetch([LOGON, named('application', []), pvwaError(400, 'AppID already exists')])
    try {
      const result = await deploy(deployContext([APP]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch('AppID already exists')
      expect(result.message).toMatch(/0 of 1/)
    } finally {
      fake.restore()
    }
  })

  it('reports failure rather than throwing when an auth method is rejected', async () => {
    const fake = recordFetch([
      LOGON,
      named('application', []),
      created(),
      named('authentication', []),
      pvwaError(403, 'Not authorized to manage authentications'),
    ])
    try {
      const result = await deploy(deployContext([APP]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch('Not authorized to manage authentications')
    } finally {
      fake.restore()
    }
  })

  it('treats a brand-new application’s missing authentication list as empty, not as an error', async () => {
    const fake = recordFetch([
      LOGON,
      named('application', []),
      created(),
      pvwaError(404, 'Application has no authentications'),
      created(),
      created(),
    ])
    try {
      const result = await deploy(deployContext([APP]))

      expect(result.success).toBe(true)
      const adds = vendorCalls(fake.calls).filter((c) => c.method === 'POST' && /Authentications$/.test(c.url))
      expect(adds).toHaveLength(2)
    } finally {
      fake.restore()
    }
  })
})
