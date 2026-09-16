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
  leaksToken,
  named,
  ok,
  pvwaError,
  recordFetch,
  vendorCalls,
} from '../../lib/__tests__/fakePvwa'

/** ⚠ Write-only: this must reach PVWA on create and appear nowhere else. */
const INITIAL_PASSWORD = 'Str0ng-Initial-Password!'

const USER = item('User 1', {
  username: 'svc-backup',
  description: 'backup service account',
  initial_password: INITIAL_PASSWORD,
  vault_authorization: ['AddSafes', 'AuditUsers'],
  enable_user: true,
})

const LIVE_USER = {
  id: 42,
  username: 'svc-backup',
  userType: 'EPVUser',
  description: 'something an admin typed',
  location: '\\',
  enableUser: false,
  vaultAuthorization: ['AuditUsers'],
}

describe('CyberArk Vault Users Deploy Handler', () => {
  it('refuses without a credential instead of calling PVWA', async () => {
    const fake = recordFetch([])
    try {
      const result = await deploy(deployContext([USER], { credential: null }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('logs on before the first resource call and sends the raw session token', async () => {
    const fake = recordFetch([LOGON, named('Users', []), created({ id: 42 })])
    try {
      await deploy(deployContext([USER]))

      expect(isLogon(fake.calls[0])).toBe(true)
      expect(fake.calls[0].authorization).toBeNull()
      expect(vendorCalls(fake.calls)[0].authorization).toBe(LOGON_TOKEN)
    } finally {
      fake.restore()
    }
  })

  it('creates a Vault user that does not exist yet', async () => {
    const fake = recordFetch([LOGON, named('Users', []), created({ id: 42 })])
    try {
      const result = await deploy(deployContext([USER]))

      const calls = vendorCalls(fake.calls)
      expect(calls[0].url).toBe(`${API_URL}/Users`)
      expect(calls[0].method).toBe('GET')

      const create = calls[1]
      expect(create.method).toBe('POST')
      expect(create.url).toBe(`${API_URL}/Users`)
      const body = bodyOf(create) as Record<string, unknown>
      expect(body.username).toBe('svc-backup')
      expect(body.userType).toBe('EPVUser')
      expect(body.location).toBe('\\')
      expect(body.vaultAuthorization).toEqual(['AddSafes', 'AuditUsers'])

      expect(result.success).toBe(true)
      const rollbackData = result.rollbackData as {
        previousState: Array<{ existed: boolean; id?: string }>
        createdIds: string[]
      }
      expect(rollbackData.previousState[0].existed).toBe(false)
      expect(rollbackData.previousState[0].id).toBe('42')
      expect(rollbackData.createdIds).toEqual(['42'])
    } finally {
      fake.restore()
    }
  })

  it('sends the initial password only on create, and never reports it back', async () => {
    const fake = recordFetch([LOGON, named('Users', []), created({ id: 42 })])
    try {
      const result = await deploy(deployContext([USER]))

      const create = vendorCalls(fake.calls)[1]
      expect((bodyOf(create) as Record<string, unknown>).initialPassword).toBe(INITIAL_PASSWORD)

      // The password is write-only: nothing the pipeline stores or shows may carry it.
      expect(JSON.stringify(result.message)).toMatch('svc-backup')
      expect(JSON.stringify(result.message).includes(INITIAL_PASSWORD)).toBe(false)
      expect(JSON.stringify(result.artifacts ?? {}).includes(INITIAL_PASSWORD)).toBe(false)
      expect(JSON.stringify(result.rollbackData ?? {}).includes(INITIAL_PASSWORD)).toBe(false)
      expect(leaksToken(result)).toBe(false)
    } finally {
      fake.restore()
    }
  })

  it('never sends the initial password when updating an existing user', async () => {
    const fake = recordFetch([LOGON, named('Users', [LIVE_USER]), ok()])
    try {
      const result = await deploy(deployContext([USER]))

      const update = vendorCalls(fake.calls)[1]
      expect(update.method).toBe('PUT')
      expect(update.url).toBe(`${API_URL}/Users/42`)

      const body = bodyOf(update) as Record<string, unknown>
      expect(body.initialPassword).toBeUndefined()
      expect(body.id).toBe(42)
      expect(body.description).toBe('backup service account')
      expect(body.enableUser).toBe(true)
      expect(body.vaultAuthorization).toEqual(['AddSafes', 'AuditUsers'])

      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })

  it('captures the live user as rollback state before updating it', async () => {
    const fake = recordFetch([LOGON, named('Users', [LIVE_USER]), ok()])
    try {
      const result = await deploy(deployContext([USER]))

      const rollbackData = result.rollbackData as {
        previousState: Array<{ existed: boolean; id?: string; prior?: { description?: string; enableUser?: boolean } }>
      }
      expect(rollbackData.previousState[0].existed).toBe(true)
      expect(rollbackData.previousState[0].id).toBe('42')
      expect(rollbackData.previousState[0].prior?.description).toBe('something an admin typed')
      expect(rollbackData.previousState[0].prior?.enableUser).toBe(false)
    } finally {
      fake.restore()
    }
  })

  it('matches an existing user case-insensitively rather than creating a duplicate', async () => {
    const fake = recordFetch([LOGON, named('Users', [{ ...LIVE_USER, username: 'SVC-Backup' }]), ok()])
    try {
      await deploy(deployContext([USER]))

      expect(vendorCalls(fake.calls)[1].method).toBe('PUT')
    } finally {
      fake.restore()
    }
  })

  it('reports failure rather than throwing when PVWA rejects the create', async () => {
    const fake = recordFetch([LOGON, named('Users', []), pvwaError(400, 'User name already exists')])
    try {
      const result = await deploy(deployContext([USER]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch('User name already exists')
      expect(result.message.includes(INITIAL_PASSWORD)).toBe(false)
    } finally {
      fake.restore()
    }
  })

  it('reports failure rather than throwing when the user list itself fails', async () => {
    const fake = recordFetch([LOGON, pvwaError(403, 'Not authorized to list users')])
    try {
      const result = await deploy(deployContext([USER]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch('Not authorized to list users')
    } finally {
      fake.restore()
    }
  })
})
