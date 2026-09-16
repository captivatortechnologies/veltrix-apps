import deploy, { type RollbackEntry } from '../deploy'
import {
  AUTH_TOKEN,
  NO_BASE_URL_SETTINGS,
  NO_ORG_KEY_SETTINGS,
  ORG_KEY,
  cbError,
  cbJson,
  cbNotFound,
  deployContext,
  mentionsSecret,
  objectBody,
  withFetch,
  writes,
  type ItemInput,
} from '../../../lib/__tests__/fakeCb'

const CONFIG_TYPE = 'access-grants'
const USERS = `/appservices/v6/orgs/${ORG_KEY}/users`
const GRANTS = `/access/v2/orgs/${ORG_KEY}/grants`
const ORG_REF = `psc:org:${ORG_KEY}`

const ALICE = 'alice@corp.example'
const ALICE_LOGIN = 4001
const ALICE_URN = `psc:user:${ORG_KEY}:${ALICE_LOGIN}`
// The principal URN is percent-encoded into the grant path — the colons must not
// survive as path separators.
const ALICE_GRANT = `${GRANTS}/psc%3Auser%3A${ORG_KEY}%3A${ALICE_LOGIN}`

const ANALYST = 'psc:role::SECOPS_ROLE_ANALYST'
const MANAGER = 'psc:role::SECOPS_ROLE_MANAGER'
/** A role granted directly in the CBC console — this app must never revoke it. */
const OUT_OF_BAND = `psc:role:${ORG_KEY}:INCIDENT_RESPONDER`

const USER_LIST = cbJson({ users: [{ login_id: ALICE_LOGIN, email: ALICE }] })

function ctx(items: ItemInput[], opts: Record<string, unknown> = {}) {
  return deployContext({ configTypeId: CONFIG_TYPE, items, ...opts })
}

function grant(principalEmail: string, roles: string[]): ItemInput {
  return { name: principalEmail, fields: { principalEmail, roles } }
}

function liveGrant(roles: string[], extra: Record<string, unknown> = {}) {
  return cbJson({ principal: ALICE_URN, principal_name: 'Alice Example', org_ref: ORG_REF, roles, ...extra })
}

function entries(result: { rollbackData?: unknown }): RollbackEntry[] {
  return ((result.rollbackData as { entries?: RollbackEntry[] } | undefined)?.entries ?? [])
}

describe('carbon-black access-grants deploy handler', () => {
  it('refuses without a credential instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([grant(ALICE, [ANALYST])], { credential: null }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the Org Key setting is blank instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([grant(ALICE, [ANALYST])], { settings: NO_ORG_KEY_SETTINGS }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Org Key/)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the region base URL is blank instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(ctx([grant(ALICE, [ANALYST])], { settings: NO_BASE_URL_SETTINGS }))

      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('authenticates every request with the API key and never echoes the secret', async () => {
    await withFetch([USER_LIST, cbNotFound(), cbJson({})], async (calls) => {
      const result = await deploy(ctx([grant(ALICE, [ANALYST])]))

      expect(result.success).toBe(true)
      // There is no OAuth exchange — the very first call is already a real request.
      expect(calls[0].path).toBe(USERS)
      expect(calls).toHaveLength(3)
      for (const call of calls) expect(call.authToken).toBe(AUTH_TOKEN)
      expect(mentionsSecret(result.message)).toBe(false)
    })
  })

  it('creates a grant for a principal that has none and records it as app-created', async () => {
    await withFetch([USER_LIST, cbNotFound(), cbJson({})], async (calls) => {
      const result = await deploy(ctx([grant(ALICE, [ANALYST])]))

      expect(result.success).toBe(true)
      expect(result.message).toContain('1 access grant')
      const posted = writes(calls)
      expect(posted).toHaveLength(1)
      expect(posted[0].method).toBe('POST')
      // A create goes to the collection, not to the principal's own path.
      expect(posted[0].path).toBe(`${GRANTS}/`)
      expect(objectBody(posted[0])).toEqual({
        principal: ALICE_URN,
        principal_name: ALICE,
        org_ref: ORG_REF,
        roles: [ANALYST],
      })
      // `existed: false` + empty priorRoles is what tells rollback the grant is ours to delete.
      expect(entries(result)).toEqual([
        {
          itemId: 'item-1',
          principalEmail: ALICE,
          principalUrn: ALICE_URN,
          existed: false,
          declaredRoles: [ANALYST],
          priorRoles: [],
        },
      ])
    })
  })

  it('reads the grant at the percent-encoded principal path before writing', async () => {
    await withFetch([USER_LIST, cbNotFound(), cbJson({})], async (calls) => {
      await deploy(ctx([grant(ALICE, [ANALYST])]))

      expect(calls[1].method).toBe('GET')
      expect(calls[1].path).toBe(ALICE_GRANT)
    })
  })

  it('merges declared roles onto the live grant and never strips an out-of-band role', async () => {
    await withFetch([USER_LIST, liveGrant([OUT_OF_BAND]), cbJson({})], async (calls) => {
      const result = await deploy(ctx([grant(ALICE, [ANALYST])]))

      expect(result.success).toBe(true)
      const put = writes(calls)
      expect(put).toHaveLength(1)
      expect(put[0].method).toBe('PUT')
      expect(put[0].path).toBe(ALICE_GRANT)
      // The whole point of the additive contract: the role another admin granted
      // is still in the body this app PUTs back.
      expect(objectBody(put[0])).toEqual({
        principal: ALICE_URN,
        principal_name: 'Alice Example',
        org_ref: ORG_REF,
        roles: [OUT_OF_BAND, ANALYST],
      })
    })
  })

  it('records the live pre-deploy roles as priorRoles, not the merged set', async () => {
    await withFetch([USER_LIST, liveGrant([OUT_OF_BAND]), cbJson({})], async () => {
      const result = await deploy(ctx([grant(ALICE, [ANALYST])]))

      expect(entries(result)).toEqual([
        {
          itemId: 'item-1',
          principalEmail: ALICE,
          principalUrn: ALICE_URN,
          existed: true,
          declaredRoles: [ANALYST],
          priorRoles: [OUT_OF_BAND],
        },
      ])
    })
  })

  it('carries priorRoles forward unchanged on a second deploy', async () => {
    const prior: RollbackEntry[] = [
      {
        itemId: 'item-1',
        principalEmail: ALICE,
        principalUrn: ALICE_URN,
        existed: true,
        declaredRoles: [ANALYST],
        priorRoles: [OUT_OF_BAND],
      },
    ]
    // The live grant now already carries the first deploy's merge.
    await withFetch([USER_LIST, liveGrant([OUT_OF_BAND, ANALYST]), cbJson({})], async (calls) => {
      const result = await deploy(ctx([grant(ALICE, [ANALYST, MANAGER])], { priorEntries: prior }))

      expect(result.success).toBe(true)
      expect(objectBody(writes(calls)[0]).roles).toEqual([OUT_OF_BAND, ANALYST, MANAGER])
      // Overwriting priorRoles with the now-merged set would make rollback a no-op
      // and leave every role this app ever granted in place.
      expect(entries(result)[0].priorRoles).toEqual([OUT_OF_BAND])
      expect(entries(result)[0].declaredRoles).toEqual([ANALYST, MANAGER])
    })
  })

  it('keeps a grant it created marked as app-created across a second deploy', async () => {
    const prior: RollbackEntry[] = [
      {
        itemId: 'item-1',
        principalEmail: ALICE,
        principalUrn: ALICE_URN,
        existed: false,
        declaredRoles: [ANALYST],
        priorRoles: [],
      },
    ]
    await withFetch([USER_LIST, liveGrant([ANALYST]), cbJson({})], async () => {
      const result = await deploy(ctx([grant(ALICE, [ANALYST, MANAGER])], { priorEntries: prior }))

      // Still ours, so a rollback still deletes the whole grant.
      expect(entries(result)[0].existed).toBe(false)
      expect(entries(result)[0].priorRoles).toEqual([])
    })
  })

  it('does not duplicate a role the principal already holds', async () => {
    await withFetch([USER_LIST, liveGrant([ANALYST, OUT_OF_BAND]), cbJson({})], async (calls) => {
      const result = await deploy(ctx([grant(ALICE, [ANALYST])]))

      expect(result.success).toBe(true)
      expect(objectBody(writes(calls)[0]).roles).toEqual([ANALYST, OUT_OF_BAND])
    })
  })

  it('leaves a profiles-based grant completely untouched and surfaces it', async () => {
    await withFetch([USER_LIST, cbJson({ principal: ALICE_URN, profiles: [{ orgs: { allow: [ORG_REF] } }] })], async (calls) => {
      const result = await deploy(ctx([grant(ALICE, [ANALYST])]))

      expect(result.success).toBe(false)
      expect(result.message).toContain('multi-org profiles')
      // Overwriting it with a roles-only body would silently drop MSSP scoping.
      expect(writes(calls)).toHaveLength(0)
      expect(entries(result)).toEqual([])
    })
  })

  it('fails the principal whose user does not exist rather than creating one', async () => {
    await withFetch([cbJson({ users: [{ login_id: 9, email: 'someone.else@corp.example' }] })], async (calls) => {
      const result = await deploy(ctx([grant(ALICE, [ANALYST])]))

      expect(result.success).toBe(false)
      expect(result.message).toContain('no matching Carbon Black user found')
      expect(calls).toHaveLength(1)
      expect(writes(calls)).toHaveLength(0)
    })
  })

  it('stops at the user-listing failure rather than writing against an unknown live state', async () => {
    await withFetch([cbError('API key lacks org.users READ', 403)], async (calls) => {
      const result = await deploy(ctx([grant(ALICE, [ANALYST])]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to list Carbon Black users/)
      expect(result.message).toContain('API key lacks org.users READ')
      expect(calls).toHaveLength(1)
      expect(writes(calls)).toHaveLength(0)
    })
  })

  it('treats a non-404 grant read as a failure and writes nothing', async () => {
    await withFetch([USER_LIST, cbError('grant service unavailable', 503)], async (calls) => {
      const result = await deploy(ctx([grant(ALICE, [ANALYST])]))

      expect(result.success).toBe(false)
      expect(result.message).toContain('grant service unavailable')
      expect(writes(calls)).toHaveLength(0)
      expect(entries(result)).toEqual([])
    })
  })

  it('reports failure rather than throwing when the vendor rejects the create', async () => {
    await withFetch([USER_LIST, cbNotFound(), cbError('role is not permitted for this org', 400)], async () => {
      const result = await deploy(ctx([grant(ALICE, [ANALYST])]))

      // A handler that throws surfaces as an opaque pipeline crash; the contract
      // is a DeployResult carrying the reason.
      expect(result.success).toBe(false)
      expect(result.message).toContain('role is not permitted for this org')
      expect(mentionsSecret(result.message)).toBe(false)
      expect(entries(result)).toEqual([])
    })
  })

  it('reports failure rather than throwing when the vendor rejects the merge', async () => {
    await withFetch([USER_LIST, liveGrant([OUT_OF_BAND]), cbError('grant version conflict', 409)], async () => {
      const result = await deploy(ctx([grant(ALICE, [ANALYST])]))

      expect(result.success).toBe(false)
      expect(result.message).toContain('grant version conflict')
      expect(entries(result)).toEqual([])
    })
  })

  it('resolves the principal from a bare-array Users response too', async () => {
    await withFetch([cbJson([{ login_id: ALICE_LOGIN, email: ALICE }]), cbNotFound(), cbJson({})], async (calls) => {
      const result = await deploy(ctx([grant(ALICE, [ANALYST])]))

      expect(result.success).toBe(true)
      expect(objectBody(writes(calls)[0]).principal).toBe(ALICE_URN)
    })
  })

  it('matches the Carbon Black user by email case-insensitively', async () => {
    await withFetch(
      [cbJson({ users: [{ login_id: ALICE_LOGIN, email: 'Alice@Corp.Example' }] }), cbNotFound(), cbJson({})],
      async (calls) => {
        const result = await deploy(ctx([grant('Alice@Corp.Example', [ANALYST])]))

        expect(result.success).toBe(true)
        expect(objectBody(writes(calls)[0]).principal).toBe(ALICE_URN)
      },
    )
  })

  it('revokes only the roles it granted when a principal is no longer declared', async () => {
    const prior: RollbackEntry[] = [
      {
        itemId: 'item-9',
        principalEmail: ALICE,
        principalUrn: ALICE_URN,
        existed: true,
        declaredRoles: [ANALYST],
        priorRoles: [OUT_OF_BAND],
      },
    ]
    await withFetch([USER_LIST, liveGrant([OUT_OF_BAND, ANALYST]), cbJson({})], async (calls) => {
      const result = await deploy(ctx([], { priorEntries: prior }))

      expect(result.success).toBe(true)
      const put = writes(calls)
      expect(put).toHaveLength(1)
      expect(put[0].method).toBe('PUT')
      expect(put[0].path).toBe(ALICE_GRANT)
      // Read-modify-write: only the declared role comes out, the other stays.
      expect(objectBody(put[0]).roles).toEqual([OUT_OF_BAND])
    })
  })

  it('deletes an undeclared grant only when it created it and no roles remain', async () => {
    const prior: RollbackEntry[] = [
      {
        itemId: 'item-9',
        principalEmail: ALICE,
        principalUrn: ALICE_URN,
        existed: false,
        declaredRoles: [ANALYST],
        priorRoles: [],
      },
    ]
    await withFetch([USER_LIST, liveGrant([ANALYST]), cbJson({})], async (calls) => {
      const result = await deploy(ctx([], { priorEntries: prior }))

      expect(result.success).toBe(true)
      const deletes = writes(calls)
      expect(deletes).toHaveLength(1)
      expect(deletes[0].method).toBe('DELETE')
      expect(deletes[0].path).toBe(ALICE_GRANT)
    })
  })

  it('empties but never deletes an undeclared grant it merely adopted', async () => {
    const prior: RollbackEntry[] = [
      {
        itemId: 'item-9',
        principalEmail: ALICE,
        principalUrn: ALICE_URN,
        existed: true,
        declaredRoles: [ANALYST],
        priorRoles: [],
      },
    ]
    await withFetch([USER_LIST, liveGrant([ANALYST]), cbJson({})], async (calls) => {
      const result = await deploy(ctx([], { priorEntries: prior }))

      expect(result.success).toBe(true)
      const put = writes(calls)
      expect(put).toHaveLength(1)
      expect(put[0].method).toBe('PUT')
      expect(objectBody(put[0]).roles).toEqual([])
    })
  })

  it('leaves an undeclared grant alone when nothing it granted is still present', async () => {
    const prior: RollbackEntry[] = [
      {
        itemId: 'item-9',
        principalEmail: ALICE,
        principalUrn: ALICE_URN,
        existed: false,
        declaredRoles: [ANALYST],
        priorRoles: [],
      },
    ]
    await withFetch([USER_LIST, liveGrant([OUT_OF_BAND])], async (calls) => {
      const result = await deploy(ctx([], { priorEntries: prior }))

      // Someone already revoked what this app added; re-writing the grant would
      // only risk clobbering the role that is left.
      expect(result.success).toBe(true)
      expect(writes(calls)).toHaveLength(0)
    })
  })

  it('never writes to a profiles-based grant while reconciling either', async () => {
    const prior: RollbackEntry[] = [
      {
        itemId: 'item-9',
        principalEmail: ALICE,
        principalUrn: ALICE_URN,
        existed: false,
        declaredRoles: [ANALYST],
        priorRoles: [],
      },
    ]
    await withFetch([USER_LIST, cbJson({ principal: ALICE_URN, profiles: [{ orgs: { allow: [ORG_REF] } }] })], async (calls) => {
      const result = await deploy(ctx([], { priorEntries: prior }))

      expect(result.success).toBe(true)
      expect(writes(calls)).toHaveLength(0)
    })
  })

  it('treats an undeclared grant that is already gone as nothing to revoke', async () => {
    const prior: RollbackEntry[] = [
      {
        itemId: 'item-9',
        principalEmail: ALICE,
        principalUrn: ALICE_URN,
        existed: false,
        declaredRoles: [ANALYST],
        priorRoles: [],
      },
    ]
    await withFetch([USER_LIST, cbNotFound()], async (calls) => {
      const result = await deploy(ctx([], { priorEntries: prior }))

      expect(result.success).toBe(true)
      expect(writes(calls)).toHaveLength(0)
    })
  })

  it('reports the revoke failure rather than throwing when the vendor rejects it', async () => {
    const prior: RollbackEntry[] = [
      {
        itemId: 'item-9',
        principalEmail: ALICE,
        principalUrn: ALICE_URN,
        existed: true,
        declaredRoles: [ANALYST],
        priorRoles: [OUT_OF_BAND],
      },
    ]
    await withFetch([USER_LIST, liveGrant([OUT_OF_BAND, ANALYST]), cbError('grant is locked', 409)], async () => {
      const result = await deploy(ctx([], { priorEntries: prior }))

      expect(result.success).toBe(false)
      expect(result.message).toContain('grant is locked')
      expect(mentionsSecret(result.message)).toBe(false)
    })
  })

  it('does not revoke a principal that is still declared', async () => {
    const prior: RollbackEntry[] = [
      {
        itemId: 'item-1',
        principalEmail: ALICE,
        principalUrn: ALICE_URN,
        existed: true,
        declaredRoles: [ANALYST],
        priorRoles: [OUT_OF_BAND],
      },
    ]
    await withFetch([USER_LIST, liveGrant([OUT_OF_BAND, ANALYST]), cbJson({})], async (calls) => {
      const result = await deploy(ctx([grant(ALICE, [ANALYST])], { priorEntries: prior }))

      expect(result.success).toBe(true)
      const put = writes(calls)
      expect(put).toHaveLength(1)
      expect(objectBody(put[0]).roles).toEqual([OUT_OF_BAND, ANALYST])
    })
  })

  it('deploys anyway when the platform cannot supply the previous deployment', async () => {
    await withFetch([USER_LIST, cbNotFound(), cbJson({})], async () => {
      const result = await deploy(ctx([grant(ALICE, [ANALYST])], { platformThrows: true }))

      expect(result.success).toBe(true)
      expect(entries(result)).toHaveLength(1)
    })
  })

  it('keeps the API secret in the auth header — never in a URL, a body or a message', async () => {
    await withFetch([USER_LIST, cbNotFound(), cbError('unauthorized', 401)], async (calls) => {
      const result = await deploy(ctx([grant(ALICE, [ANALYST])]))

      expect(result.success).toBe(false)
      expect(mentionsSecret(result.message)).toBe(false)
      for (const call of calls) {
        expect(mentionsSecret(call.url)).toBe(false)
        expect(mentionsSecret(call.body)).toBe(false)
      }
    })
  })
})
