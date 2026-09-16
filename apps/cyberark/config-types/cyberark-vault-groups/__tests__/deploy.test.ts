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
  ok,
  pvwaError,
  recordFetch,
  vendorCalls,
} from '../../lib/__tests__/fakePvwa'

const GROUP = item('Group 1', {
  group_name: 'Vault Admins',
  description: 'privileged vault administrators',
  members: '[{"member_id":"alice","member_type":"vault"}]',
})

const LIVE_GROUP = { id: 7, groupName: 'Vault Admins', description: 'stale description', location: '\\' }

describe('CyberArk Vault Groups Deploy Handler', () => {
  it('refuses without a credential instead of calling PVWA', async () => {
    const fake = recordFetch([])
    try {
      const result = await deploy(deployContext([GROUP], { credential: null }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('logs on before the first resource call and sends the raw session token', async () => {
    const fake = recordFetch([LOGON, collection([]), created({ id: 7, groupName: 'Vault Admins' }), ok({ id: 7, members: [] }), created()])
    try {
      await deploy(deployContext([GROUP]))

      expect(isLogon(fake.calls[0])).toBe(true)
      expect(fake.calls[0].authorization).toBeNull()
      expect(vendorCalls(fake.calls)[0].authorization).toBe(LOGON_TOKEN)
    } finally {
      fake.restore()
    }
  })

  it('creates a group that does not exist yet and adds its declared members', async () => {
    const fake = recordFetch([
      LOGON,
      collection([]),
      created({ id: 7, groupName: 'Vault Admins' }),
      ok({ id: 7, groupName: 'Vault Admins', members: [] }),
      created(),
    ])
    try {
      const result = await deploy(deployContext([GROUP]))

      const calls = vendorCalls(fake.calls)
      expect(calls[0].url).toBe(`${API_URL}/UserGroups/`)

      expect(calls[1].method).toBe('POST')
      expect(calls[1].url).toBe(`${API_URL}/UserGroups/`)
      expect(bodyOf(calls[1])).toEqual({
        groupName: 'Vault Admins',
        description: 'privileged vault administrators',
        location: '\\',
      })

      expect(calls[2].method).toBe('GET')
      expect(calls[2].url).toBe(`${API_URL}/UserGroups/7?includeMembers=true`)

      expect(calls[3].method).toBe('POST')
      expect(calls[3].url).toBe(`${API_URL}/UserGroups/7/Members`)
      expect(bodyOf(calls[3])).toEqual({ memberId: 'alice', memberType: 'vault' })

      expect(result.success).toBe(true)
      const rollbackData = result.rollbackData as {
        previousState: Array<{ existed: boolean; id?: string; priorMembers: unknown[] }>
        createdIds: string[]
      }
      expect(rollbackData.previousState[0].existed).toBe(false)
      expect(rollbackData.previousState[0].id).toBe('7')
      expect(rollbackData.previousState[0].priorMembers).toEqual([])
      expect(rollbackData.createdIds).toEqual(['7'])
    } finally {
      fake.restore()
    }
  })

  it('updates an existing group and reconciles membership both ways', async () => {
    const fake = recordFetch([
      LOGON,
      collection([LIVE_GROUP]),
      ok(),
      ok({ id: 7, members: [{ username: 'bob', memberType: 'vault' }] }),
      created(),
      ok(),
    ])
    try {
      const result = await deploy(deployContext([GROUP]))

      const calls = vendorCalls(fake.calls)
      expect(calls[1].method).toBe('PUT')
      expect(calls[1].url).toBe(`${API_URL}/UserGroups/7`)

      expect(calls[3].method).toBe('POST')
      expect(bodyOf(calls[3])).toEqual({ memberId: 'alice', memberType: 'vault' })

      expect(calls[4].method).toBe('DELETE')
      expect(calls[4].url).toBe(`${API_URL}/UserGroups/7/members/bob`)

      expect(result.success).toBe(true)
      const rollbackData = result.rollbackData as {
        previousState: Array<{ existed: boolean; prior?: { description: string }; priorMembers: Array<{ username?: string }> }>
      }
      expect(rollbackData.previousState[0].existed).toBe(true)
      expect(rollbackData.previousState[0].prior?.description).toBe('stale description')
      expect(rollbackData.previousState[0].priorMembers[0].username).toBe('bob')
    } finally {
      fake.restore()
    }
  })

  it('does not PUT a group whose fields already match', async () => {
    const unchanged = { ...LIVE_GROUP, description: 'privileged vault administrators' }
    const fake = recordFetch([
      LOGON,
      collection([unchanged]),
      ok({ id: 7, members: [{ username: 'alice', memberType: 'vault' }] }),
    ])
    try {
      const result = await deploy(deployContext([GROUP]))

      const calls = vendorCalls(fake.calls)
      expect(calls).toHaveLength(2)
      expect(calls.some((c) => c.method === 'PUT')).toBe(false)
      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })

  it('reports failure rather than throwing when PVWA rejects the create', async () => {
    const fake = recordFetch([LOGON, collection([]), pvwaError(409, 'Group already exists')])
    try {
      const result = await deploy(deployContext([GROUP]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch('Group already exists')
      expect(result.message).toMatch(/0 of 1/)
    } finally {
      fake.restore()
    }
  })

  it('reports failure rather than throwing when a member cannot be added', async () => {
    const fake = recordFetch([
      LOGON,
      collection([]),
      created({ id: 7, groupName: 'Vault Admins' }),
      ok({ id: 7, members: [] }),
      pvwaError(404, 'User alice was not found'),
    ])
    try {
      const result = await deploy(deployContext([GROUP]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch('User alice was not found')
      // The group it had already created is still recorded, so rollback can undo it.
      const rollbackData = result.rollbackData as { createdIds: string[] }
      expect(rollbackData.createdIds).toEqual(['7'])
    } finally {
      fake.restore()
    }
  })

  it('requires a domain member to carry its domain name in the add body', async () => {
    const domainGroup = item('Group 1', {
      group_name: 'Vault Admins',
      description: 'privileged vault administrators',
      members: '[{"member_id":"AD-Admins","member_type":"domain","domain_name":"corp.example.com"}]',
    })
    const fake = recordFetch([
      LOGON,
      collection([]),
      created({ id: 7, groupName: 'Vault Admins' }),
      ok({ id: 7, members: [] }),
      created(),
    ])
    try {
      await deploy(deployContext([domainGroup]))

      expect(bodyOf(vendorCalls(fake.calls)[3])).toEqual({
        memberId: 'AD-Admins',
        memberType: 'domain',
        domainName: 'corp.example.com',
      })
    } finally {
      fake.restore()
    }
  })
})
