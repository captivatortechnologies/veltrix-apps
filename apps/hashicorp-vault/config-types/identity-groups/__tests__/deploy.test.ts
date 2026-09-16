import deploy, { type GroupRollbackEntry } from '../deploy'
import {
  FORBIDDEN,
  NOT_FOUND,
  NO_CONTENT,
  VAULT_BASE,
  VAULT_TOKEN,
  assertNoTokenLeak,
  makeCanvas,
  makeDeployContext,
  recordFetch,
} from '../../../lib/__tests__/vaultTestHarness'

function canvasWith(groups: Array<Record<string, unknown>>) {
  return makeCanvas(
    groups.map((fields, i) => ({ name: `Group ${i + 1}`, fields })),
    'identity-groups',
  )
}

function rollbackEntries(result: { rollbackData?: unknown }): GroupRollbackEntry[] {
  return (result.rollbackData as { previousState?: GroupRollbackEntry[] })?.previousState ?? []
}

function createdNames(result: { rollbackData?: unknown }): string[] {
  return (result.rollbackData as { createdNames?: string[] })?.createdNames ?? []
}

function liveGroup(overrides: Record<string, unknown> = {}) {
  return {
    status: 200,
    body: {
      data: {
        id: 'g-1',
        name: 'platform-admins',
        type: 'internal',
        policies: ['ops'],
        member_entity_ids: ['e-1'],
        member_group_ids: [],
        metadata: { owner: 'platform' },
        ...overrides,
      },
    },
  }
}

describe('Vault Identity Groups Deploy Handler', () => {
  it('refuses without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ name: 'platform-admins' }]), { token: null }),
      )

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
      const result = await deploy(
        makeDeployContext(canvasWith([{ name: 'platform-admins' }]), { hostname: '' }),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Vault address/i)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('authenticates on its very first request and never leaks the token', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT])
    try {
      const result = await deploy(makeDeployContext(canvasWith([{ name: 'platform-admins' }])))

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

  it('looks the group up by name and creates it when the lookup 404s', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT])
    try {
      const result = await deploy(
        makeDeployContext(
          canvasWith([
            {
              name: 'platform-admins',
              type: 'internal',
              policies: ['ops', 'admin'],
              memberEntityIds: ['e-1', 'e-2'],
              memberGroupIds: ['g-9'],
            },
          ]),
        ),
      )

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(2)

      const [lookup, write] = fetchStub.calls
      expect(lookup.method).toBe('GET')
      expect(lookup.url).toBe(`${VAULT_BASE}/identity/group/name/platform-admins`)
      expect(write.method).toBe('POST')
      expect(write.url).toBe(`${VAULT_BASE}/identity/group/name/platform-admins`)
      expect(JSON.parse(write.body)).toEqual({
        type: 'internal',
        policies: ['ops', 'admin'],
        member_entity_ids: ['e-1', 'e-2'],
        member_group_ids: ['g-9'],
      })

      const entries = rollbackEntries(result)
      expect(entries).toHaveLength(1)
      expect(entries[0].existed).toBe(false)
      expect(entries[0].prior).toBeUndefined()
      expect(createdNames(result)).toEqual(['platform-admins'])
    } finally {
      fetchStub.restore()
    }
  })

  it('updates the group the lookup found and captures its prior state verbatim', async () => {
    const fetchStub = recordFetch([liveGroup(), NO_CONTENT])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ name: 'platform-admins', type: 'internal', policies: ['admin'] }])),
      )

      expect(result.success).toBe(true)
      const entries = rollbackEntries(result)
      expect(entries[0].existed).toBe(true)
      expect(entries[0].prior).toEqual({
        type: 'internal',
        policies: ['ops'],
        member_entity_ids: ['e-1'],
        member_group_ids: [],
        metadata: { owner: 'platform' },
      })
      expect(createdNames(result)).toEqual([])
    } finally {
      fetchStub.restore()
    }
  })

  it('accepts a live group returned without the data wrapper', async () => {
    const fetchStub = recordFetch([
      { status: 200, body: { id: 'g-1', name: 'platform-admins', type: 'internal', policies: [] } },
      NO_CONTENT,
    ])
    try {
      const result = await deploy(makeDeployContext(canvasWith([{ name: 'platform-admins' }])))

      expect(result.success).toBe(true)
      expect(rollbackEntries(result)[0].existed).toBe(true)
      expect(createdNames(result)).toEqual([])
    } finally {
      fetchStub.restore()
    }
  })

  it('refuses to change an immutable group type and never writes', async () => {
    const fetchStub = recordFetch([liveGroup({ type: 'external' })])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ name: 'platform-admins', type: 'internal' }])),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/immutable/)
      expect(result.message).toMatch(/already exists with type "external"/)
      // Only the lookup happened — nothing was written.
      expect(fetchStub.calls).toHaveLength(1)
      expect(fetchStub.calls[0].method).toBe('GET')
      expect(rollbackEntries(result)).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('never sends member lists for an external group — Vault manages those via group-aliases', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT])
    try {
      await deploy(
        makeDeployContext(
          canvasWith([
            {
              name: 'okta-admins',
              type: 'external',
              policies: ['ops'],
              memberEntityIds: ['e-1'],
              memberGroupIds: ['g-1'],
            },
          ]),
        ),
      )

      const body = JSON.parse(fetchStub.calls[1].body)
      expect(Object.keys(body)).toEqual(['type', 'policies'])
      expect(fetchStub.calls[1].body.includes('member_entity_ids')).toBe(false)
      expect(fetchStub.calls[1].body.includes('member_group_ids')).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('omits metadata entirely when none is authored, leaving the live metadata untouched', async () => {
    const fetchStub = recordFetch([liveGroup(), NO_CONTENT])
    try {
      await deploy(makeDeployContext(canvasWith([{ name: 'platform-admins' }])))

      expect(fetchStub.calls[1].body.includes('metadata')).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('sends authored metadata and skips a metadata value that is not a JSON object', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT, NOT_FOUND, NO_CONTENT])
    try {
      await deploy(
        makeDeployContext(
          canvasWith([
            { name: 'good', metadataJson: '{"owner":"platform"}' },
            { name: 'broken', metadataJson: 'not json' },
          ]),
        ),
      )

      expect(JSON.parse(fetchStub.calls[1].body).metadata).toEqual({ owner: 'platform' })
      expect(fetchStub.calls[3].body.includes('metadata')).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('defaults an unset type to internal', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT])
    try {
      await deploy(makeDeployContext(canvasWith([{ name: 'platform-admins' }])))

      expect(JSON.parse(fetchStub.calls[1].body).type).toBe('internal')
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when Vault rejects the write', async () => {
    const fetchStub = recordFetch([NOT_FOUND, FORBIDDEN])
    try {
      const result = await deploy(makeDeployContext(canvasWith([{ name: 'platform-admins' }])))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to upsert identity group "platform-admins"/)
      expect(result.message).toMatch(/permission denied/)
      assertNoTokenLeak(result.message, result.artifacts, result.rollbackData)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when the name lookup errors', async () => {
    const fetchStub = recordFetch([{ status: 500, body: { errors: ['internal error'] } }])
    try {
      const result = await deploy(makeDeployContext(canvasWith([{ name: 'platform-admins' }])))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to read identity group "platform-admins"/)
      expect((result.artifacts as { deployedGroups: string[] }).deployedGroups).toEqual([])
    } finally {
      fetchStub.restore()
    }
  })

  it('keeps the first group rollbackable when a later one fails', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT, liveGroup({ name: 'second' }), FORBIDDEN])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ name: 'first' }, { name: 'second' }])),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/after 1 of 2 group/)
      expect((result.artifacts as { deployedGroups: string[] }).deployedGroups).toEqual(['first'])
      // The first is rollbackable, and the second's prior state was captured before the failed write.
      expect(rollbackEntries(result)).toHaveLength(2)
      expect(rollbackEntries(result)[0].existed).toBe(false)
      expect(rollbackEntries(result)[1].existed).toBe(true)
      expect(createdNames(result)).toEqual(['first'])
    } finally {
      fetchStub.restore()
    }
  })

  it('skips sections with no group name without calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await deploy(makeDeployContext(canvasWith([{ name: '  ' }, { type: 'internal' }])))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })
})
