import deploy from '../deploy'
import {
  API_URL,
  LOGON,
  LOGON_TOKEN,
  bodyOf,
  collection,
  created,
  deployContext,
  isLogon,
  item,
  leaksToken,
  ok,
  pvwaError,
  recordFetch,
  vendorCalls,
} from '../../lib/__tests__/fakePvwa'

/** ⚠ Write-only: this must reach PVWA on create and appear nowhere else. */
const SECRET = 'P@ssw0rd-that-must-never-be-echoed'

const ACCOUNT = item('Account 1', {
  name: 'svc-sql',
  safe_name: 'App-Prod',
  platform_id: 'WinServerLocal',
  address: 'sql01.corp.example.com',
  user_name: 'svc_sql',
  secret_type: 'password',
  secret: SECRET,
  platform_account_properties: '{"Port":"1433"}',
})

const LIVE_ACCOUNT = {
  id: '77_3',
  name: 'svc-sql',
  safeName: 'App-Prod',
  platformId: 'WinServerLocal',
  address: 'sql01.corp.example.com',
  userName: 'svc_sql',
  secretManagement: { automaticManagementEnabled: true },
  platformAccountProperties: { Port: '1433' },
}

describe('CyberArk Accounts Deploy Handler', () => {
  it('refuses without a credential instead of calling PVWA', async () => {
    const fake = recordFetch([])
    try {
      const result = await deploy(deployContext([ACCOUNT], { credential: null }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('logs on before the first resource call and sends the raw session token', async () => {
    const fake = recordFetch([LOGON, collection([]), created({ id: '77_3' })])
    try {
      await deploy(deployContext([ACCOUNT]))

      expect(isLogon(fake.calls[0])).toBe(true)
      expect(fake.calls[0].authorization).toBeNull()
      expect(vendorCalls(fake.calls)[0].authorization).toBe(LOGON_TOKEN)
    } finally {
      fake.restore()
    }
  })

  it('creates an account that does not exist yet, searching by name first', async () => {
    const fake = recordFetch([LOGON, collection([]), created({ id: '77_3' })])
    try {
      const result = await deploy(deployContext([ACCOUNT]))

      const calls = vendorCalls(fake.calls)
      expect(calls[0].method).toBe('GET')
      expect(calls[0].url).toMatch('search=svc-sql')

      const create = calls[1]
      expect(create.method).toBe('POST')
      expect(create.url).toBe(`${API_URL}/Accounts`)
      const body = bodyOf(create) as Record<string, unknown>
      expect(body.name).toBe('svc-sql')
      expect(body.safeName).toBe('App-Prod')
      expect(body.platformId).toBe('WinServerLocal')
      expect(body.platformAccountProperties).toEqual({ Port: '1433' })
      expect(body.secretManagement).toEqual({ automaticManagementEnabled: true })

      expect(result.success).toBe(true)
      const rollbackData = result.rollbackData as {
        previousState: Array<{ existed: boolean; id?: string }>
        createdIds: string[]
      }
      expect(rollbackData.previousState[0].existed).toBe(false)
      expect(rollbackData.createdIds).toEqual(['77_3'])
    } finally {
      fake.restore()
    }
  })

  it('sends the secret only on create, and never reports it back', async () => {
    const fake = recordFetch([LOGON, collection([]), created({ id: '77_3' })])
    try {
      const result = await deploy(deployContext([ACCOUNT]))

      expect((bodyOf(vendorCalls(fake.calls)[1]) as Record<string, unknown>).secret).toBe(SECRET)

      expect(JSON.stringify(result.message).includes(SECRET)).toBe(false)
      expect(JSON.stringify(result.artifacts ?? {}).includes(SECRET)).toBe(false)
      expect(JSON.stringify(result.rollbackData ?? {}).includes(SECRET)).toBe(false)
      expect(leaksToken(result)).toBe(false)
    } finally {
      fake.restore()
    }
  })

  it('patches only the non-secret fields that actually differ', async () => {
    const drifted = { ...LIVE_ACCOUNT, address: 'old-sql01.corp.example.com' }
    const fake = recordFetch([LOGON, collection([drifted]), ok()])
    try {
      const result = await deploy(deployContext([ACCOUNT]))

      const patch = vendorCalls(fake.calls)[1]
      expect(patch.method).toBe('PATCH')
      expect(patch.url).toBe(`${API_URL}/Accounts/77_3`)

      const ops = bodyOf(patch) as Array<{ op: string; path: string; value: unknown }>
      expect(ops).toEqual([{ op: 'replace', path: '/address', value: 'sql01.corp.example.com' }])
      expect(JSON.stringify(ops).includes(SECRET)).toBe(false)

      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })

  it('makes no write at all when the live account already matches', async () => {
    const fake = recordFetch([LOGON, collection([LIVE_ACCOUNT])])
    try {
      const result = await deploy(deployContext([ACCOUNT]))

      const calls = vendorCalls(fake.calls)
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('GET')
      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })

  it('upserts a platform property with `add`, which works whether or not it is set', async () => {
    const fake = recordFetch([LOGON, collection([{ ...LIVE_ACCOUNT, platformAccountProperties: {} }]), ok()])
    try {
      await deploy(deployContext([ACCOUNT]))

      const ops = bodyOf(vendorCalls(fake.calls)[1]) as Array<{ op: string; path: string; value: unknown }>
      expect(ops).toEqual([{ op: 'add', path: '/platformAccountProperties/Port', value: '1433' }])
    } finally {
      fake.restore()
    }
  })

  it('does not treat a same-named account in another safe as a match', async () => {
    const elsewhere = { ...LIVE_ACCOUNT, safeName: 'Other-Safe' }
    const fake = recordFetch([LOGON, collection([elsewhere]), created({ id: '88_1' })])
    try {
      const result = await deploy(deployContext([ACCOUNT]))

      expect(vendorCalls(fake.calls)[1].method).toBe('POST')
      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })

  it('captures the prior non-secret fields of an updated account for rollback', async () => {
    const drifted = { ...LIVE_ACCOUNT, address: 'old-sql01.corp.example.com' }
    const fake = recordFetch([LOGON, collection([drifted]), ok()])
    try {
      const result = await deploy(deployContext([ACCOUNT]))

      const rollbackData = result.rollbackData as {
        previousState: Array<{ existed: boolean; id?: string; prior?: { address?: string; platformAccountProperties?: unknown } }>
      }
      expect(rollbackData.previousState[0].existed).toBe(true)
      expect(rollbackData.previousState[0].id).toBe('77_3')
      expect(rollbackData.previousState[0].prior?.address).toBe('old-sql01.corp.example.com')
      expect(rollbackData.previousState[0].prior?.platformAccountProperties).toEqual({ Port: '1433' })
    } finally {
      fake.restore()
    }
  })

  it('fails loudly when PVWA accepts the create but returns no account id', async () => {
    const fake = recordFetch([LOGON, collection([]), created({})])
    try {
      const result = await deploy(deployContext([ACCOUNT]))

      // Without an id there is nothing to delete on rollback — that must not
      // be reported as a clean deploy.
      expect(result.success).toBe(false)
      expect(result.message).toMatch('returned no id')
    } finally {
      fake.restore()
    }
  })

  it('reports failure rather than throwing when PVWA rejects the create', async () => {
    const fake = recordFetch([LOGON, collection([]), pvwaError(403, 'You are not authorized to add accounts')])
    try {
      const result = await deploy(deployContext([ACCOUNT]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch('You are not authorized to add accounts')
      expect(result.message.includes(SECRET)).toBe(false)
    } finally {
      fake.restore()
    }
  })

  it('requires a manual-management reason to travel with a disabled automatic management', async () => {
    const manual = item('Account 1', {
      ...ACCOUNT.fields,
      automatic_management_enabled: false,
      manual_management_reason: 'rotated by the DBA team',
    })
    const fake = recordFetch([LOGON, collection([]), created({ id: '77_3' })])
    try {
      await deploy(deployContext([manual]))

      const body = bodyOf(vendorCalls(fake.calls)[1]) as Record<string, unknown>
      expect(body.secretManagement).toEqual({
        automaticManagementEnabled: false,
        manualManagementReason: 'rotated by the DBA team',
      })
    } finally {
      fake.restore()
    }
  })
})
