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
  named,
  ok,
  pvwaError,
  recordFetch,
  vendorCalls,
} from '../../lib/__tests__/fakePvwa'

const GROUP = item('Group 1', {
  group_name: 'SQLCluster',
  safe_name: 'App-Prod',
  group_platform_id: 'WinDomainGroup',
  members: '[{"account_name":"svc-sql","safe_name":"App-Prod"}]',
})

const LIVE_GROUP = { GroupID: 12, GroupName: 'SQLCluster', GroupPlatformID: 'WinDomainGroup', Safe: 'App-Prod' }

const ACCOUNT_SEARCH = collection([{ id: '77_3', name: 'svc-sql', safeName: 'App-Prod' }])

describe('CyberArk Account Groups Deploy Handler', () => {
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
    const fake = recordFetch([LOGON, collection([]), created(LIVE_GROUP), collection([]), ACCOUNT_SEARCH, created()])
    try {
      await deploy(deployContext([GROUP]))

      expect(isLogon(fake.calls[0])).toBe(true)
      expect(fake.calls[0].authorization).toBeNull()
      expect(vendorCalls(fake.calls)[0].authorization).toBe(LOGON_TOKEN)
    } finally {
      fake.restore()
    }
  })

  it('creates a group that does not exist yet and attaches its declared accounts', async () => {
    const fake = recordFetch([LOGON, collection([]), created(LIVE_GROUP), collection([]), ACCOUNT_SEARCH, created()])
    try {
      const result = await deploy(deployContext([GROUP]))

      const calls = vendorCalls(fake.calls)
      expect(calls[0].url).toBe(`${API_URL}/AccountGroups?Safe=App-Prod`)

      expect(calls[1].method).toBe('POST')
      expect(calls[1].url).toBe(`${API_URL}/AccountGroups/`)
      expect(bodyOf(calls[1])).toEqual({
        GroupName: 'SQLCluster',
        GroupPlatformID: 'WinDomainGroup',
        Safe: 'App-Prod',
      })

      expect(calls[2].url).toBe(`${API_URL}/AccountGroups/12/Members/`)
      expect(calls[3].url).toMatch('search=svc-sql')

      expect(calls[4].method).toBe('POST')
      expect(calls[4].url).toBe(`${API_URL}/AccountGroups/12/Members/`)
      expect(bodyOf(calls[4])).toEqual({ AccountID: '77_3' })

      expect(result.success).toBe(true)
      const rollbackData = result.rollbackData as {
        previousState: Array<{ existed: boolean; groupId?: string; priorMemberAccountIds: string[] }>
      }
      expect(rollbackData.previousState[0].existed).toBe(false)
      expect(rollbackData.previousState[0].groupId).toBe('12')
      expect(rollbackData.previousState[0].priorMemberAccountIds).toEqual([])
    } finally {
      fake.restore()
    }
  })

  it('detaches an account that is no longer declared', async () => {
    const fake = recordFetch([
      LOGON,
      named('value', [LIVE_GROUP]),
      named('Members', [{ AccountID: '99_9' }]),
      ACCOUNT_SEARCH,
      created(),
      ok(),
    ])
    try {
      const result = await deploy(deployContext([GROUP]))

      const calls = vendorCalls(fake.calls)
      // No create — the group already existed.
      expect(calls.some((c) => c.url === `${API_URL}/AccountGroups/`)).toBe(false)
      expect(calls[3].method).toBe('POST')
      expect(calls[4].method).toBe('DELETE')
      expect(calls[4].url).toBe(`${API_URL}/AccountGroups/12/Members/99_9/`)

      const rollbackData = result.rollbackData as {
        previousState: Array<{ existed: boolean; priorMemberAccountIds: string[] }>
      }
      expect(rollbackData.previousState[0].existed).toBe(true)
      expect(rollbackData.previousState[0].priorMemberAccountIds).toEqual(['99_9'])
    } finally {
      fake.restore()
    }
  })

  it('notes, rather than silently ignores, a GroupPlatformID it cannot change', async () => {
    const fake = recordFetch([
      LOGON,
      named('value', [{ ...LIVE_GROUP, GroupPlatformID: 'SomethingElse' }]),
      named('Members', [{ AccountID: '77_3' }]),
      ACCOUNT_SEARCH,
    ])
    try {
      const result = await deploy(deployContext([GROUP]))

      expect(result.success).toBe(true)
      const notes = (result.artifacts as { notes: string[] }).notes
      expect(notes).toHaveLength(1)
      expect(notes[0]).toMatch('GroupPlatformID cannot be changed')
      expect(result.message).toMatch('1 note(s)')
    } finally {
      fake.restore()
    }
  })

  it('refuses to attach an account that does not exist', async () => {
    const fake = recordFetch([LOGON, collection([]), created(LIVE_GROUP), collection([]), collection([])])
    try {
      const result = await deploy(deployContext([GROUP]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch('Account "svc-sql" in safe "App-Prod" was not found')
      // Membership is never touched when a member cannot be resolved, so the
      // group is left exactly as the create found it. Note that the entry is
      // only pushed to rollbackState AFTER reconciliation, so the group this
      // deploy just created is absent from the recorded state.
      const rollbackData = result.rollbackData as { previousState: unknown[] }
      expect(rollbackData.previousState).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('reports failure rather than throwing when PVWA rejects the create', async () => {
    const fake = recordFetch([LOGON, collection([]), pvwaError(400, 'Group name is already in use')])
    try {
      const result = await deploy(deployContext([GROUP]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch('Group name is already in use')
      expect(result.message).toMatch(/0 of 1/)
    } finally {
      fake.restore()
    }
  })

  it('notes a created group whose GroupID PVWA never returned', async () => {
    const fake = recordFetch([LOGON, collection([]), created({})])
    try {
      const result = await deploy(deployContext([GROUP]))

      expect(result.success).toBe(true)
      const notes = (result.artifacts as { notes: string[] }).notes
      expect(notes[0]).toMatch('membership could not be reconciled')
    } finally {
      fake.restore()
    }
  })

  it('lists a safe’s groups once when several groups share a safe', async () => {
    const second = item('Group 2', {
      group_name: 'WebCluster',
      safe_name: 'App-Prod',
      group_platform_id: 'WinDomainGroup',
      members: '',
    })
    const fake = recordFetch([
      LOGON,
      named('value', [LIVE_GROUP, { ...LIVE_GROUP, GroupID: 13, GroupName: 'WebCluster' }]),
      named('Members', [{ AccountID: '77_3' }]),
      ACCOUNT_SEARCH,
      named('Members', []),
    ])
    try {
      const result = await deploy(deployContext([GROUP, second]))

      const lists = vendorCalls(fake.calls).filter((c) => c.url === `${API_URL}/AccountGroups?Safe=App-Prod`)
      expect(lists).toHaveLength(1)
      expect(result.success).toBe(true)
    } finally {
      fake.restore()
    }
  })
})
