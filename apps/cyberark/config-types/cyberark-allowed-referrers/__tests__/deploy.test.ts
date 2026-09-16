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
  named,
  pvwaError,
  recordFetch,
  vendorCalls,
} from '../../lib/__tests__/fakePvwa'

const REFERRER = item('Referrer 1', { referrer_url: 'https://portal.corp.example.com', regular_expression: false })

const REFERRERS_URL = `${API_URL}/Configuration/AccessRestriction/AllowedReferrers`

describe('CyberArk Allowed Referrers Deploy Handler', () => {
  it('refuses without a credential instead of calling PVWA', async () => {
    const fake = recordFetch([])
    try {
      const result = await deploy(deployContext([REFERRER], { credential: null }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('logs on before the first resource call and sends the raw session token', async () => {
    const fake = recordFetch([LOGON, named('AllowedReferrers', []), created({ id: 3 })])
    try {
      await deploy(deployContext([REFERRER]))

      expect(isLogon(fake.calls[0])).toBe(true)
      expect(fake.calls[0].authorization).toBeNull()
      expect(vendorCalls(fake.calls)[0].authorization).toBe(LOGON_TOKEN)
    } finally {
      fake.restore()
    }
  })

  it('adds a referrer that is not on the allow-list yet', async () => {
    const fake = recordFetch([LOGON, named('AllowedReferrers', []), created({ id: 3 })])
    try {
      const result = await deploy(deployContext([REFERRER]))

      const calls = vendorCalls(fake.calls)
      expect(calls[0].method).toBe('GET')
      expect(calls[0].url).toBe(REFERRERS_URL)

      expect(calls[1].method).toBe('POST')
      expect(calls[1].url).toBe(REFERRERS_URL)
      expect(bodyOf(calls[1])).toEqual({
        referrerURL: 'https://portal.corp.example.com',
        regularExpression: false,
      })

      expect(result.success).toBe(true)
      const rollbackData = result.rollbackData as { previousState: Array<{ existed: boolean; id?: string }> }
      expect(rollbackData.previousState[0].existed).toBe(false)
      expect(rollbackData.previousState[0].id).toBe('3')
    } finally {
      fake.restore()
    }
  })

  it('never re-adds a referrer that is already on the allow-list', async () => {
    const fake = recordFetch([
      LOGON,
      named('AllowedReferrers', [{ referrerURL: 'https://portal.corp.example.com', regularExpression: false, id: 3 }]),
    ])
    try {
      const result = await deploy(deployContext([REFERRER]))

      expect(vendorCalls(fake.calls)).toHaveLength(1)
      expect(result.success).toBe(true)
      const rollbackData = result.rollbackData as { previousState: Array<{ existed: boolean; id?: string }> }
      expect(rollbackData.previousState[0].existed).toBe(true)
      expect(rollbackData.previousState[0].id).toBe('3')
    } finally {
      fake.restore()
    }
  })

  it('matches an existing referrer case-insensitively', async () => {
    const fake = recordFetch([
      LOGON,
      named('AllowedReferrers', [{ referrerURL: 'HTTPS://Portal.Corp.Example.com', id: 3 }]),
    ])
    try {
      await deploy(deployContext([REFERRER]))

      expect(vendorCalls(fake.calls).some((c) => c.method === 'POST')).toBe(false)
    } finally {
      fake.restore()
    }
  })

  it('notes, rather than silently ignores, a regularExpression flag it cannot change', async () => {
    const fake = recordFetch([
      LOGON,
      named('AllowedReferrers', [{ referrerURL: 'https://portal.corp.example.com', regularExpression: true, id: 3 }]),
    ])
    try {
      const result = await deploy(deployContext([REFERRER]))

      expect(result.success).toBe(true)
      const notes = (result.artifacts as { notes: string[] }).notes
      expect(notes).toHaveLength(1)
      expect(notes[0]).toMatch('no verified update endpoint')
      expect(result.message).toMatch('1 note(s)')
    } finally {
      fake.restore()
    }
  })

  it("reads PVWA's string-valued regularExpression flag as a boolean", async () => {
    const fake = recordFetch([
      LOGON,
      named('AllowedReferrers', [{ referrerURL: 'https://portal.corp.example.com', regularExpression: 'false', id: 3 }]),
    ])
    try {
      const result = await deploy(deployContext([REFERRER]))

      expect((result.artifacts as { notes: string[] }).notes).toHaveLength(0)
    } finally {
      fake.restore()
    }
  })

  it('records a created referrer with no id rather than inventing one', async () => {
    const fake = recordFetch([LOGON, named('AllowedReferrers', []), created({})])
    try {
      const result = await deploy(deployContext([REFERRER]))

      expect(result.success).toBe(true)
      const rollbackData = result.rollbackData as { previousState: Array<{ id?: string }> }
      expect(rollbackData.previousState[0].id).toBeUndefined()
    } finally {
      fake.restore()
    }
  })

  it('reports failure rather than throwing when PVWA rejects the add', async () => {
    const fake = recordFetch([LOGON, named('AllowedReferrers', []), pvwaError(403, 'Not authorized to change PVWA configuration')])
    try {
      const result = await deploy(deployContext([REFERRER]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch('Not authorized to change PVWA configuration')
      expect(result.message).toMatch(/0 of 1/)
    } finally {
      fake.restore()
    }
  })

  it('reports failure rather than throwing when the referrer list itself fails', async () => {
    const fake = recordFetch([LOGON, pvwaError(500, 'PVWA is down')])
    try {
      const result = await deploy(deployContext([REFERRER]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch('PVWA is down')
    } finally {
      fake.restore()
    }
  })
})
