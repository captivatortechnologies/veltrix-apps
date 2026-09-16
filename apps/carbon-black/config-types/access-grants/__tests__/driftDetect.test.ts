import driftDetect from '../driftDetect'
import {
  AUTH_TOKEN,
  NO_BASE_URL_SETTINGS,
  NO_ORG_KEY_SETTINGS,
  ORG_KEY,
  cbError,
  cbJson,
  cbNotFound,
  driftContext,
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
const ALICE_GRANT = `${GRANTS}/psc%3Auser%3A${ORG_KEY}%3A${ALICE_LOGIN}`
const BOB = 'bob@corp.example'
const BOB_LOGIN = 4002

const ANALYST = 'psc:role::SECOPS_ROLE_ANALYST'
const MANAGER = 'psc:role::SECOPS_ROLE_MANAGER'
/** A role granted directly in the CBC console — additive drift must ignore it. */
const OUT_OF_BAND = `psc:role:${ORG_KEY}:INCIDENT_RESPONDER`

const USER_LIST = cbJson({ users: [{ login_id: ALICE_LOGIN, email: ALICE }] })
const BOTH_USERS = cbJson({
  users: [
    { login_id: ALICE_LOGIN, email: ALICE },
    { login_id: BOB_LOGIN, email: BOB },
  ],
})

function ctx(items: ItemInput[], opts: Record<string, unknown> = {}) {
  return driftContext({ configTypeId: CONFIG_TYPE, items, ...opts })
}

function grant(principalEmail: string, roles: string[]): ItemInput {
  return { name: principalEmail, fields: { principalEmail, roles } }
}

function liveGrant(roles: unknown) {
  return cbJson({ principal: ALICE_URN, principal_name: 'Alice Example', org_ref: ORG_REF, roles })
}

const DEPLOYED = grant(ALICE, [ANALYST])

function fields(result: { diffs: Array<{ field: string }> }): string[] {
  return result.diffs.map((d) => d.field)
}

describe('carbon-black access-grants driftDetect handler', () => {
  it('reports no drift without a credential instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED], { credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift when the Org Key setting is blank', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED], { settings: NO_ORG_KEY_SETTINGS }))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift when the region base URL is blank', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED], { settings: NO_BASE_URL_SETTINGS }))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('does not even list users when nothing is declared', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(ctx([]))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('finds no drift when the principal still holds every declared role', async () => {
    await withFetch([USER_LIST, liveGrant([ANALYST])], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(calls).toHaveLength(2)
      expect(calls[0].path).toBe(USERS)
      expect(calls[1].path).toBe(ALICE_GRANT)
      for (const call of calls) expect(call.authToken).toBe(AUTH_TOKEN)
    })
  })

  it('never writes while detecting drift', async () => {
    await withFetch([USER_LIST, liveGrant([])], async (calls) => {
      await driftDetect(ctx([DEPLOYED]))

      expect(writes(calls)).toHaveLength(0)
    })
  })

  it('flags a missing user as critical and stops before reading their grant', async () => {
    await withFetch([cbJson({ users: [{ login_id: 9, email: 'someone.else@corp.example' }] })], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe(ALICE)
      expect(result.diffs[0].expected).toBe('user present')
      expect(result.diffs[0].actual).toBe('user not found')
      expect(result.diffs[0].severity).toBe('critical')
      expect(calls).toHaveLength(1)
    })
  })

  it('flags a grant deleted out of band as critical — the admin has lost all access', async () => {
    await withFetch([USER_LIST, cbNotFound()], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe(ALICE)
      expect(result.diffs[0].expected).toBe('present')
      expect(result.diffs[0].actual).toBe('absent')
      expect(result.diffs[0].severity).toBe('critical')
    })
  })

  it('flags a declared role that was revoked out of band as a warning', async () => {
    await withFetch([USER_LIST, liveGrant([MANAGER])], async () => {
      const result = await driftDetect(ctx([grant(ALICE, [ANALYST, MANAGER])]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe(`${ALICE}.roles`)
      expect(result.diffs[0].expected).toBe(ANALYST)
      expect(result.diffs[0].actual).toBe('missing')
      expect(result.diffs[0].severity).toBe('warning')
    })
  })

  it('lists every declared role that is missing in one diff', async () => {
    await withFetch([USER_LIST, liveGrant([OUT_OF_BAND])], async () => {
      const result = await driftDetect(ctx([grant(ALICE, [ANALYST, MANAGER])]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].expected).toBe(`${ANALYST}, ${MANAGER}`)
    })
  })

  it('does not report an extra live role as drift', async () => {
    await withFetch([USER_LIST, liveGrant([ANALYST, OUT_OF_BAND])], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      // Grants are additive: a role another admin added is not this app's drift
      // to report, and reporting it would invite a reconcile that revokes it.
      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
    })
  })

  it('treats a grant with null roles as missing every declared role', async () => {
    await withFetch([USER_LIST, liveGrant(null)], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe(`${ALICE}.roles`)
      expect(result.diffs[0].actual).toBe('missing')
    })
  })

  it('warns about a profiles-based grant and never writes to it', async () => {
    await withFetch(
      [USER_LIST, cbJson({ principal: ALICE_URN, profiles: [{ orgs: { allow: [ORG_REF] } }] })],
      async (calls) => {
        const result = await driftDetect(ctx([DEPLOYED]))

        expect(result.hasDrift).toBe(true)
        expect(result.diffs).toHaveLength(1)
        expect(result.diffs[0].field).toBe(`${ALICE}.roles`)
        expect(result.diffs[0].expected).toBe('roles-based grant')
        expect(result.diffs[0].actual).toBe('profiles-based grant (unmanaged)')
        expect(result.diffs[0].severity).toBe('warning')
        expect(writes(calls)).toHaveLength(0)
      },
    )
  })

  it('reports no drift when the user listing fails, rather than inventing absences', async () => {
    await withFetch([cbError('API key lacks org.users READ', 403)], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED]))

      // A handler that cannot read live state must not claim every admin lost access.
      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(calls).toHaveLength(1)
    })
  })

  it('reports no drift for a principal whose grant read fails for a reason other than 404', async () => {
    await withFetch([USER_LIST, cbError('grant service unavailable', 503)], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
    })
  })

  it('checks every declared principal and reports only the one that drifted', async () => {
    await withFetch([BOTH_USERS, liveGrant([ANALYST]), cbNotFound()], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED, grant(BOB, [MANAGER])]))

      expect(calls).toHaveLength(3)
      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(fields(result)).toContain(BOB)
    })
  })

  it('skips an item that declares no roles instead of reading a grant for it', async () => {
    await withFetch([USER_LIST, liveGrant([ANALYST])], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED, { name: 'empty', fields: { principalEmail: BOB, roles: '' } }]))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(2)
    })
  })
})
