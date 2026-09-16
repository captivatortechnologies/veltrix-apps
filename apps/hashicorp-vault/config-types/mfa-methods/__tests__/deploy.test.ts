import deploy, { type MfaMethodRollbackEntry } from '../deploy'
import {
  FORBIDDEN,
  NOT_FOUND,
  VAULT_BASE,
  VAULT_TOKEN,
  assertNoTokenLeak,
  makeCanvas,
  makeDeployContext,
  recordFetch,
} from '../../../lib/__tests__/vaultTestHarness'

const DUO_INTEGRATION_KEY = 'DIWWWWWWWWWWWWWWWWWW'
const DUO_SECRET_KEY = 'duo-SECRET-key-that-must-not-be-echoed'

const TOTP = { methodName: 'authenticator', type: 'totp', issuer: 'Veltrix' }
const DUO = {
  methodName: 'duo-push',
  type: 'duo',
  apiHostname: 'api-1234abcd.duosecurity.com',
  integrationKey: DUO_INTEGRATION_KEY,
  secretKey: DUO_SECRET_KEY,
}

function canvasWith(methods: Array<Record<string, unknown>>) {
  return makeCanvas(
    methods.map((fields, i) => ({ name: `Method ${i + 1}`, fields })),
    'mfa-methods',
  )
}

function rollbackEntries(result: { rollbackData?: unknown }): MfaMethodRollbackEntry[] {
  return (result.rollbackData as { previousState?: MfaMethodRollbackEntry[] })?.previousState ?? []
}

function createdIds(result: { rollbackData?: unknown }): string[] {
  return (result.rollbackData as { createdIds?: string[] })?.createdIds ?? []
}

const listOf = (keys: string[]) => ({ status: 200, body: { data: { keys } } })
const methodAt = (data: Record<string, unknown>) => ({ status: 200, body: { data } })

describe('Vault Login MFA Methods Deploy Handler', () => {
  it('refuses without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await deploy(makeDeployContext(canvasWith([TOTP]), { token: null }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Vault token/i)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('refuses without a Vault address instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await deploy(makeDeployContext(canvasWith([TOTP]), { hostname: '' }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Vault address/i)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('authenticates on its very first request and never leaks the token', async () => {
    const fetchStub = recordFetch([listOf([]), methodAt({ method_id: 'm-1' })])
    try {
      const result = await deploy(makeDeployContext(canvasWith([TOTP])))

      expect(result.success).toBe(true)
      expect(fetchStub.calls[0].headers['X-Vault-Token']).toBe(VAULT_TOKEN)
      for (const call of fetchStub.calls) {
        expect(call.headers['X-Vault-Token']).toBe(VAULT_TOKEN)
      }
      assertNoTokenLeak(result.message, result.artifacts, result.rollbackData)
    } finally {
      fetchStub.restore()
    }
  })

  it('creates a method the label lookup did not find and captures the generated id', async () => {
    const fetchStub = recordFetch([listOf([]), methodAt({ method_id: 'm-new' })])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ ...TOTP, period: 30, digits: 6, algorithm: 'SHA256' }])),
      )

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(2)

      const [list, create] = fetchStub.calls
      // A Vault LIST is a GET with ?list=true.
      expect(list.method).toBe('GET')
      expect(list.url).toBe(`${VAULT_BASE}/identity/mfa/method/totp?list=true`)
      expect(create.method).toBe('POST')
      // Create posts to the bare type path — the id does not exist yet.
      expect(create.url).toBe(`${VAULT_BASE}/identity/mfa/method/totp`)
      expect(JSON.parse(create.body)).toEqual({
        method_name: 'authenticator',
        issuer: 'Veltrix',
        period: 30,
        algorithm: 'SHA256',
        digits: 6,
      })

      const entries = rollbackEntries(result)
      expect(entries).toHaveLength(1)
      expect(entries[0].existed).toBe(false)
      // Rollback cannot address the method without the id Vault generated.
      expect(entries[0].methodId).toBe('m-new')
      expect(entries[0].priorBody).toBeUndefined()
      expect(createdIds(result)).toEqual(['m-new'])
      expect((result.artifacts as { createdMethodIds: string[] }).createdMethodIds).toEqual(['m-new'])
    } finally {
      fetchStub.restore()
    }
  })

  it('captures a generated id returned as `id` rather than `method_id`', async () => {
    const fetchStub = recordFetch([listOf([]), methodAt({ id: 't-1' })])
    try {
      const result = await deploy(makeDeployContext(canvasWith([TOTP])))

      expect(result.success).toBe(true)
      expect(rollbackEntries(result)[0].methodId).toBe('t-1')
      expect(createdIds(result)).toEqual(['t-1'])
    } finally {
      fetchStub.restore()
    }
  })

  it('treats a 404 on the LIST as "no methods of this type yet" and creates', async () => {
    const fetchStub = recordFetch([NOT_FOUND, methodAt({ method_id: 'm-new' })])
    try {
      const result = await deploy(makeDeployContext(canvasWith([TOTP])))

      expect(result.success).toBe(true)
      expect(fetchStub.calls[1].url).toBe(`${VAULT_BASE}/identity/mfa/method/totp`)
    } finally {
      fetchStub.restore()
    }
  })

  it('fails loudly when a created method comes back without a generated id', async () => {
    const fetchStub = recordFetch([listOf([]), { status: 204, body: '' }])
    try {
      const result = await deploy(makeDeployContext(canvasWith([TOTP])))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/was created but the API returned no method_id/)
      // With no id there is nothing rollback could address, so nothing is recorded.
      expect(rollbackEntries(result)).toHaveLength(0)
      expect(createdIds(result)).toEqual([])
    } finally {
      fetchStub.restore()
    }
  })

  it('reads each listed method and updates the one whose method_name matches', async () => {
    const fetchStub = recordFetch([
      listOf(['m-1', 'm-2']),
      methodAt({ method_id: 'm-1', method_name: 'other', issuer: 'Other' }),
      methodAt({ method_id: 'm-2', method_name: 'authenticator', issuer: 'Old Issuer', period: 60 }),
      methodAt({ method_id: 'm-2' }),
    ])
    try {
      const result = await deploy(makeDeployContext(canvasWith([TOTP])))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(4)
      expect(fetchStub.calls[1].url).toBe(`${VAULT_BASE}/identity/mfa/method/totp/m-1`)
      expect(fetchStub.calls[2].url).toBe(`${VAULT_BASE}/identity/mfa/method/totp/m-2`)
      // The update is addressed by the generated method_id, not by the name.
      expect(fetchStub.calls[3].method).toBe('POST')
      expect(fetchStub.calls[3].url).toBe(`${VAULT_BASE}/identity/mfa/method/totp/m-2`)

      const entries = rollbackEntries(result)
      expect(entries[0].existed).toBe(true)
      expect(entries[0].methodId).toBe('m-2')
      expect(entries[0].priorBody).toEqual({
        method_name: 'authenticator',
        issuer: 'Old Issuer',
        period: 60,
      })
      expect(createdIds(result)).toEqual([])
    } finally {
      fetchStub.restore()
    }
  })

  it('re-asserts the write-only duo secrets on every write but keeps them out of rollback state', async () => {
    const fetchStub = recordFetch([
      listOf(['m-1']),
      methodAt({
        method_id: 'm-1',
        method_name: 'duo-push',
        api_hostname: 'api-old.duosecurity.com',
        use_passcode: false,
      }),
      methodAt({ method_id: 'm-1' }),
    ])
    try {
      const result = await deploy(makeDeployContext(canvasWith([DUO])))

      expect(result.success).toBe(true)
      expect(JSON.parse(fetchStub.calls[2].body)).toEqual({
        method_name: 'duo-push',
        api_hostname: 'api-1234abcd.duosecurity.com',
        integration_key: DUO_INTEGRATION_KEY,
        secret_key: DUO_SECRET_KEY,
        use_passcode: false,
      })

      const priorBody = rollbackEntries(result)[0].priorBody ?? {}
      expect(Object.keys(priorBody).includes('secret_key')).toBe(false)
      expect(Object.keys(priorBody).includes('integration_key')).toBe(false)
      expect(priorBody.api_hostname).toBe('api-old.duosecurity.com')
      // A secret that lands in rollback state or an artifact is a credential disclosure.
      expect(JSON.stringify(result.rollbackData).includes(DUO_SECRET_KEY)).toBe(false)
      expect(JSON.stringify(result.artifacts).includes(DUO_SECRET_KEY)).toBe(false)
      expect(String(result.message).includes(DUO_SECRET_KEY)).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('sends the okta method body with its write-only api_token', async () => {
    const fetchStub = recordFetch([listOf([]), methodAt({ method_id: 'm-1' })])
    try {
      await deploy(
        makeDeployContext(
          canvasWith([
            {
              methodName: 'okta-verify',
              type: 'okta',
              orgName: 'example-org',
              apiToken: 'okta-api-token',
              baseUrl: 'okta.com',
              primaryEmail: true,
            },
          ]),
        ),
      )

      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/identity/mfa/method/okta?list=true`)
      expect(JSON.parse(fetchStub.calls[1].body)).toEqual({
        method_name: 'okta-verify',
        org_name: 'example-org',
        api_token: 'okta-api-token',
        base_url: 'okta.com',
        primary_email: true,
      })
    } finally {
      fetchStub.restore()
    }
  })

  it('sends the pingid method body with only its settings file and username format', async () => {
    const fetchStub = recordFetch([listOf([]), methodAt({ method_id: 'm-1' })])
    try {
      await deploy(
        makeDeployContext(
          canvasWith([
            {
              methodName: 'pingid-push',
              type: 'pingid',
              settingsFileBase64: 'c2V0dGluZ3M=',
              usernameFormat: '{{entity.name}}',
            },
          ]),
        ),
      )

      expect(JSON.parse(fetchStub.calls[1].body)).toEqual({
        method_name: 'pingid-push',
        settings_file_base64: 'c2V0dGluZ3M=',
        username_format: '{{entity.name}}',
      })
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when Vault rejects the create', async () => {
    const fetchStub = recordFetch([listOf([]), FORBIDDEN])
    try {
      const result = await deploy(makeDeployContext(canvasWith([TOTP])))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to create MFA method "authenticator" \(totp\)/)
      expect(result.message).toMatch(/permission denied/)
      assertNoTokenLeak(result.message, result.artifacts, result.rollbackData)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when Vault rejects the update', async () => {
    const fetchStub = recordFetch([
      listOf(['m-1']),
      methodAt({ method_id: 'm-1', method_name: 'authenticator' }),
      FORBIDDEN,
    ])
    try {
      const result = await deploy(makeDeployContext(canvasWith([TOTP])))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to update MFA method "authenticator" \(totp\)/)
      // The prior body was captured before the write, so the failed update is still rollbackable.
      expect(rollbackEntries(result)).toHaveLength(1)
      expect(rollbackEntries(result)[0].methodId).toBe('m-1')
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when the LIST is rejected', async () => {
    const fetchStub = recordFetch([FORBIDDEN])
    try {
      const result = await deploy(makeDeployContext(canvasWith([TOTP])))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to list totp MFA methods/)
      expect((result.artifacts as { deployedMethods: string[] }).deployedMethods).toEqual([])
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when reading a listed method errors', async () => {
    const fetchStub = recordFetch([listOf(['m-1']), FORBIDDEN])
    try {
      const result = await deploy(makeDeployContext(canvasWith([TOTP])))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to read totp MFA method m-1/)
    } finally {
      fetchStub.restore()
    }
  })

  it('keeps the first method rollbackable when a later one fails', async () => {
    const fetchStub = recordFetch([
      listOf([]),
      methodAt({ method_id: 'm-1' }),
      listOf(['m-2']),
      methodAt({ method_id: 'm-2', method_name: 'legacy', issuer: 'Old' }),
      FORBIDDEN,
    ])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([TOTP, { ...TOTP, methodName: 'legacy' }])),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/after 1 of 2 method/)
      expect((result.artifacts as { deployedMethods: string[] }).deployedMethods).toEqual([
        'authenticator',
      ])
      expect(rollbackEntries(result)).toHaveLength(2)
      expect(rollbackEntries(result)[0].methodId).toBe('m-1')
      expect(rollbackEntries(result)[1].methodId).toBe('m-2')
      expect(createdIds(result)).toEqual(['m-1'])
    } finally {
      fetchStub.restore()
    }
  })

  it('skips sections with no method name or no recognized type without calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await deploy(
        makeDeployContext(
          canvasWith([
            { methodName: '', type: 'totp' },
            { methodName: 'mystery', type: 'sms' },
          ]),
        ),
      )

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })
})
