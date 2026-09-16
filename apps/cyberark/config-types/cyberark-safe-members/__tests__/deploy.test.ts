import deploy from '../deploy'
import { SAFE_MEMBER_PERMISSIONS } from '../validate'
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
  ok,
  pvwaError,
  recordFetch,
  vendorCalls,
} from '../../lib/__tests__/fakePvwa'

const MEMBER = item('Member 1', {
  safe_name: 'App-Prod',
  member_name: 'AppOwners',
  member_type: 'Group',
  search_in: 'Vault',
  permissions: ['useAccounts', 'retrieveAccounts', 'listAccounts'],
})

const SAFES = collection([{ safeUrlId: 'App-Prod', safeName: 'App-Prod' }])

describe('CyberArk Safe Members Deploy Handler', () => {
  it('refuses without a credential instead of calling PVWA', async () => {
    const fake = recordFetch([])
    try {
      const result = await deploy(deployContext([MEMBER], { credential: null }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('logs on before the first resource call and sends the raw session token', async () => {
    const fake = recordFetch([LOGON, SAFES, collection([]), created()])
    try {
      await deploy(deployContext([MEMBER]))

      expect(isLogon(fake.calls[0])).toBe(true)
      expect(fake.calls[0].authorization).toBeNull()
      expect(vendorCalls(fake.calls)[0].authorization).toBe(LOGON_TOKEN)
    } finally {
      fake.restore()
    }
  })

  it('grants a member that is not on the safe yet, expanding the full permission object', async () => {
    const fake = recordFetch([LOGON, SAFES, collection([]), created()])
    try {
      const result = await deploy(deployContext([MEMBER]))

      const calls = vendorCalls(fake.calls)
      expect(calls[0].url).toMatch(`${API_URL}/Safes?`)
      expect(calls[1].url).toMatch(`${API_URL}/Safes/App-Prod/Members?`)

      const add = calls[2]
      expect(add.method).toBe('POST')
      expect(add.url).toBe(`${API_URL}/Safes/App-Prod/Members`)

      const body = bodyOf(add) as { memberName: string; memberType: string; searchIn: string; permissions: Record<string, boolean> }
      expect(body.memberName).toBe('AppOwners')
      expect(body.memberType).toBe('Group')
      expect(body.searchIn).toBe('Vault')

      // Every permission key must be sent explicitly — an omitted key would let
      // PVWA fall back to its own default rather than the declared grant.
      expect(Object.keys(body.permissions)).toHaveLength(SAFE_MEMBER_PERMISSIONS.length)
      expect(body.permissions.useAccounts).toBe(true)
      expect(body.permissions.retrieveAccounts).toBe(true)
      expect(body.permissions.listAccounts).toBe(true)
      expect(body.permissions.manageSafe).toBe(false)
      expect(body.permissions.manageSafeMembers).toBe(false)
      expect(body.permissions.deleteAccounts).toBe(false)

      expect(result.success).toBe(true)
      const rollbackData = result.rollbackData as {
        previousState: Array<{ existed: boolean; safeUrlId: string; memberName: string }>
      }
      expect(rollbackData.previousState[0].existed).toBe(false)
      expect(rollbackData.previousState[0].safeUrlId).toBe('App-Prod')
      expect(rollbackData.previousState[0].memberName).toBe('AppOwners')
    } finally {
      fake.restore()
    }
  })

  it('updates an existing member and captures the permissions it is replacing', async () => {
    const live = {
      memberName: 'AppOwners',
      memberType: 'Group',
      membershipExpirationDate: 1_760_000_000,
      permissions: { useAccounts: true, manageSafe: true, deleteAccounts: true },
    }
    const fake = recordFetch([LOGON, SAFES, collection([live]), ok()])
    try {
      const result = await deploy(deployContext([MEMBER]))

      const update = vendorCalls(fake.calls)[2]
      expect(update.method).toBe('PUT')
      expect(update.url).toBe(`${API_URL}/Safes/App-Prod/Members/AppOwners`)

      const body = bodyOf(update) as { permissions: Record<string, boolean>; membershipExpirationDate: number | null }
      // An update may only change expiration + permissions — never the identity.
      expect(Object.keys(body).sort()).toEqual(['membershipExpirationDate', 'permissions'])
      expect(body.membershipExpirationDate).toBeNull()
      expect(body.permissions.manageSafe).toBe(false)
      expect(body.permissions.deleteAccounts).toBe(false)

      const rollbackData = result.rollbackData as {
        previousState: Array<{ existed: boolean; prior?: { permissions: string[]; membershipExpiration: number | null } }>
      }
      expect(rollbackData.previousState[0].existed).toBe(true)
      // Captured in the API's canonical permission order, not the order PVWA
      // happened to serialise them in.
      expect(rollbackData.previousState[0].prior?.permissions).toEqual(['useAccounts', 'deleteAccounts', 'manageSafe'])
      expect(rollbackData.previousState[0].prior?.membershipExpiration).toBe(1_760_000_000)
    } finally {
      fake.restore()
    }
  })

  it('matches an existing member case-insensitively rather than adding a duplicate', async () => {
    const fake = recordFetch([LOGON, SAFES, collection([{ memberName: 'appowners', permissions: {} }]), ok()])
    try {
      await deploy(deployContext([MEMBER]))

      expect(vendorCalls(fake.calls)[2].method).toBe('PUT')
    } finally {
      fake.restore()
    }
  })

  it('refuses to grant access on a safe that does not exist', async () => {
    const fake = recordFetch([LOGON, collection([{ safeUrlId: 'Other', safeName: 'Other' }])])
    try {
      const result = await deploy(deployContext([MEMBER]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch('Safe "App-Prod" not found')
      // Nothing was granted anywhere.
      expect(vendorCalls(fake.calls).some((c) => c.method === 'POST' || c.method === 'PUT')).toBe(false)
    } finally {
      fake.restore()
    }
  })

  it('reports failure rather than throwing when PVWA rejects the grant', async () => {
    const fake = recordFetch([LOGON, SAFES, collection([]), pvwaError(403, 'You do not have Manage Safe Members')])
    try {
      const result = await deploy(deployContext([MEMBER]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch('You do not have Manage Safe Members')
      expect(result.message).toMatch(/0 of 1/)
    } finally {
      fake.restore()
    }
  })

  it('skips an item that grants no permission at all', async () => {
    const fake = recordFetch([LOGON])
    try {
      const result = await deploy(
        deployContext([item('Member 1', { safe_name: 'App-Prod', member_name: 'AppOwners', permissions: [] })]),
      )

      expect(result.success).toBe(true)
      expect(vendorCalls(fake.calls)).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('resolves the safe list once when several members share a safe', async () => {
    const second = item('Member 2', {
      safe_name: 'App-Prod',
      member_name: 'AppReaders',
      member_type: 'Group',
      permissions: ['listAccounts'],
    })
    const fake = recordFetch([LOGON, SAFES, collection([]), created(), collection([]), created()])
    try {
      const result = await deploy(deployContext([MEMBER, second]))

      const safeLists = vendorCalls(fake.calls).filter((c) => /\/Safes\?/.test(c.url))
      expect(safeLists).toHaveLength(1)
      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })
})
