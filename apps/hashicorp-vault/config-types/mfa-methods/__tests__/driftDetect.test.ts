import driftDetect from '../driftDetect'
import {
  FORBIDDEN,
  NOT_FOUND,
  VAULT_BASE,
  assertNoTokenLeak,
  makeCanvas,
  makeDriftContext,
  recordFetch,
} from '../../../lib/__tests__/vaultTestHarness'

const DUO_SECRET_KEY = 'duo-SECRET-key-that-must-not-be-echoed'

const listOf = (keys: string[]) => ({ status: 200, body: { data: { keys } } })
const methodAt = (data: Record<string, unknown>) => ({ status: 200, body: { data } })

function ctx(fields: Record<string, unknown>, o: { token?: string | null } = {}) {
  return makeDriftContext(makeCanvas([{ name: 'Method 1', fields }], 'mfa-methods'), o)
}

const TOTP = {
  methodName: 'authenticator',
  type: 'totp',
  issuer: 'Veltrix',
  period: 30,
  digits: 6,
  algorithm: 'SHA256',
}

const liveTotp = (overrides: Record<string, unknown> = {}) =>
  methodAt({
    method_id: 'm-1',
    method_name: 'authenticator',
    issuer: 'Veltrix',
    period: 30,
    digits: 6,
    algorithm: 'SHA256',
    ...overrides,
  })

describe('Vault Login MFA Methods Drift Detect Handler', () => {
  it('reports no drift without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await driftDetect(ctx(TOTP, { token: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports no drift when the live method matches', async () => {
    const fetchStub = recordFetch([listOf(['m-1']), liveTotp()])
    try {
      const result = await driftDetect(ctx(TOTP))

      expect(result.hasDrift).toBe(false)
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/identity/mfa/method/totp?list=true`)
      expect(fetchStub.calls[1].url).toBe(`${VAULT_BASE}/identity/mfa/method/totp/m-1`)
    } finally {
      fetchStub.restore()
    }
  })

  it('normalizes numbers Vault returns as strings — "30" is not drift against 30', async () => {
    const fetchStub = recordFetch([listOf(['m-1']), liveTotp({ period: '30', digits: '6' })])
    try {
      const result = await driftDetect(ctx(TOTP))

      expect(result.hasDrift).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('normalizes a blank live string to unset — surrounding whitespace is not drift', async () => {
    const fetchStub = recordFetch([
      listOf(['m-1']),
      methodAt({ method_id: 'm-1', method_name: 'duo-push', api_hostname: '  api-1.duosecurity.com  ' }),
    ])
    try {
      const result = await driftDetect(
        ctx({
          methodName: 'duo-push',
          type: 'duo',
          apiHostname: 'api-1.duosecurity.com',
          integrationKey: 'DIWWWWWWWWWWWWWWWWWW',
          secretKey: DUO_SECRET_KEY,
        }),
      )

      expect(result.hasDrift).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('flags a method that no longer exists as critical drift', async () => {
    const fetchStub = recordFetch([NOT_FOUND])
    try {
      const result = await driftDetect(ctx(TOTP))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('authenticator')
      expect(result.diffs[0].expected).toBe('exists')
      expect(result.diffs[0].actual).toBe('missing')
      expect(result.diffs[0].severity).toBe('critical')
    } finally {
      fetchStub.restore()
    }
  })

  it('flags a changed non-secret field as a warning naming that field', async () => {
    const fetchStub = recordFetch([listOf(['m-1']), liveTotp({ issuer: 'Tampered', period: 60 })])
    try {
      const result = await driftDetect(ctx(TOTP))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(2)
      expect(result.diffs[0].field).toBe('authenticator.issuer')
      expect(result.diffs[0].expected).toBe('Veltrix')
      expect(result.diffs[0].actual).toBe('Tampered')
      expect(result.diffs[0].severity).toBe('warning')
      expect(result.diffs[1].field).toBe('authenticator.period')
      expect(result.diffs[1].actual).toBe('60')
    } finally {
      fetchStub.restore()
    }
  })

  it('renders an unset live field as "not set" rather than undefined', async () => {
    const fetchStub = recordFetch([listOf(['m-1']), liveTotp({ issuer: undefined })])
    try {
      const result = await driftDetect(ctx(TOTP))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('authenticator.issuer')
      expect(result.diffs[0].actual).toBe('not set')
    } finally {
      fetchStub.restore()
    }
  })

  it('never diffs the write-only duo secrets Vault cannot return', async () => {
    const fetchStub = recordFetch([
      listOf(['m-1']),
      methodAt({
        method_id: 'm-1',
        method_name: 'duo-push',
        api_hostname: 'api-1.duosecurity.com',
        use_passcode: false,
      }),
    ])
    try {
      const result = await driftDetect(
        ctx({
          methodName: 'duo-push',
          type: 'duo',
          apiHostname: 'api-1.duosecurity.com',
          integrationKey: 'DIWWWWWWWWWWWWWWWWWW',
          secretKey: DUO_SECRET_KEY,
        }),
      )

      // Comparing a write-only secret to an absent live value would report false
      // drift forever — and would put the secret in the diff.
      expect(result.hasDrift).toBe(false)
      expect(JSON.stringify(result.diffs).includes(DUO_SECRET_KEY)).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('flags a duo passcode setting changed out of band', async () => {
    const fetchStub = recordFetch([
      listOf(['m-1']),
      methodAt({
        method_id: 'm-1',
        method_name: 'duo-push',
        api_hostname: 'api-1.duosecurity.com',
        use_passcode: true,
      }),
    ])
    try {
      const result = await driftDetect(
        ctx({
          methodName: 'duo-push',
          type: 'duo',
          apiHostname: 'api-1.duosecurity.com',
          integrationKey: 'DIWWWWWWWWWWWWWWWWWW',
          secretKey: DUO_SECRET_KEY,
        }),
      )

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('duo-push.usePasscode')
      expect(result.diffs[0].expected).toBe('false')
      expect(result.diffs[0].actual).toBe('true')
    } finally {
      fetchStub.restore()
    }
  })

  it('diffs only the username format of a pingid method — the settings file is write-only', async () => {
    const fetchStub = recordFetch([
      listOf(['m-1']),
      methodAt({
        method_id: 'm-1',
        method_name: 'pingid-push',
        username_format: '{{entity.name}}',
        idp_url: 'https://idpxnyl3m.pingidentity.com/pingid',
        admin_url: 'https://admin.pingone.com/web-portal',
      }),
    ])
    try {
      const result = await driftDetect(
        ctx({
          methodName: 'pingid-push',
          type: 'pingid',
          settingsFileBase64: 'c2V0dGluZ3M=',
          usernameFormat: '{{entity.name}}',
        }),
      )

      expect(result.hasDrift).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('records an unreachable diff rather than throwing when Vault errors', async () => {
    const fetchStub = recordFetch([FORBIDDEN])
    try {
      const result = await driftDetect(ctx(TOTP))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('authenticator')
      expect(result.diffs[0].expected).toBe('reachable')
      expect(String(result.diffs[0].actual)).toMatch(/unreachable/)
      expect(result.diffs[0].severity).toBe('critical')
      assertNoTokenLeak(result.diffs)
    } finally {
      fetchStub.restore()
    }
  })

  it('keeps checking the remaining methods after one errors', async () => {
    const canvas = makeCanvas(
      [
        { name: 'Method 1', fields: TOTP },
        { name: 'Method 2', fields: { ...TOTP, methodName: 'legacy' } },
      ],
      'mfa-methods',
    )
    const fetchStub = recordFetch([
      FORBIDDEN,
      listOf(['m-2']),
      liveTotp({ method_id: 'm-2', method_name: 'legacy' }),
    ])
    try {
      const result = await driftDetect(makeDriftContext(canvas))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(fetchStub.calls).toHaveLength(3)
    } finally {
      fetchStub.restore()
    }
  })

  it('ignores sections with no method name or no recognized type', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await driftDetect(ctx({ ...TOTP, type: 'sms' }))

      expect(result.hasDrift).toBe(false)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })
})
