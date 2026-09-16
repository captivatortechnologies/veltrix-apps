// =============================================================================
// group-rules — deploy, driven against the fake Okta org.
//
// A group rule assigns EVERY matching user to a group automatically, so it is an
// access grant with no human in the loop. Okta's lifecycle rules make this the
// most order-sensitive handler in the app: rules are born INACTIVE, a rule must
// be INACTIVE to accept a PUT, and the `actions` block is immutable — a changed
// target group forces a delete + recreate. Get that sequence wrong and the rule
// silently stops assigning, or the old rule is destroyed with nothing to replace
// it. These tests pin the sequence, the bodies and the rollback state recorded.
// =============================================================================

import deploy from '../deploy'
import { OKTA_EXPRESSION_TYPE } from '../validate'
import {
  API_BASE,
  API_TOKEN,
  apiError,
  deployContext,
  emptyCredential,
  EMPTY_LIST,
  leaksToken,
  notFound,
  ok,
  withFetch,
  writeCalls,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

function rule(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Engineering rule section',
    fields: {
      name: 'Engineering auto-assign',
      expression: 'user.department=="Engineering"',
      groupIds: ['00gENG'],
      status: 'ACTIVE',
      ...fields,
    },
  }
}

const LIVE_RULE = {
  id: '0prLIVE',
  type: 'group_rule',
  status: 'ACTIVE',
  name: 'Engineering auto-assign',
  conditions: { expression: { value: 'user.department=="Engineering"', type: OKTA_EXPRESSION_TYPE } },
  actions: { assignUserToGroups: { groupIds: ['00gENG'] } },
}

describe('group-rules deploy', () => {
  it('refuses before touching the org when no credential is configured', async () => {
    const result = await withFetch([], async (calls) => {
      const res = await deploy(deployContext({ sections: [rule()], credential: null }))
      expect(calls).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/API token/i)
  })

  it('refuses when the credential exists but carries no SSWS token', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [rule()], credential: emptyCredential() }))
      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [rule()], hostname: '' }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('sends the SSWS token on its first request and never echoes it back', async () => {
    await withFetch([EMPTY_LIST, ok({ id: '0prNEW' }), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [rule()] }))

      expect(calls[0].path).toBe('/groups/rules')
      expect(calls[0].method).toBe('GET')
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(calls[0].url).toMatch(API_BASE)
      expect(result.success).toBe(true)
      expect(leaksToken(result)).toBe(false)
    })
  })

  it('creates an absent rule INACTIVE, then activates it in a separate call', async () => {
    await withFetch([EMPTY_LIST, ok({ id: '0prNEW' }), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [rule()] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(2)

      expect(writes[0].method).toBe('POST')
      expect(writes[0].path).toBe('/groups/rules')
      expect(writes[0].json).toEqual({
        type: 'group_rule',
        name: 'Engineering auto-assign',
        conditions: {
          expression: { value: 'user.department=="Engineering"', type: OKTA_EXPRESSION_TYPE },
        },
        actions: { assignUserToGroups: { groupIds: ['00gENG'] } },
      })

      // The create never carries a status — activation is explicit.
      expect(writes[1].method).toBe('POST')
      expect(writes[1].path).toBe('/groups/rules/0prNEW/lifecycle/activate')
    })
  })

  it('leaves a rule authored INACTIVE dormant rather than activating it', async () => {
    await withFetch([EMPTY_LIST, ok({ id: '0prNEW' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [rule({ status: 'INACTIVE' })] }))

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.path.includes('/lifecycle/'))).toBe(false)
    })
  })

  it('records the created rule so rollback can delete it', async () => {
    const result = await withFetch([EMPTY_LIST, ok({ id: '0prNEW' }), ok({})], async () =>
      deploy(deployContext({ sections: [rule()] })),
    )

    const rb = result.rollbackData as {
      previousState: Array<Record<string, unknown>>
      createdRuleIds: string[]
    }
    expect(rb.previousState).toHaveLength(1)
    expect(rb.previousState[0].action).toBe('created')
    expect(rb.previousState[0].liveId).toBe('0prNEW')
    expect(rb.previousState[0].prior).toBeUndefined()
    expect(rb.createdRuleIds).toEqual(['0prNEW'])
  })

  it('fails rather than inventing an id when the create returns no id', async () => {
    const result = await withFetch([EMPTY_LIST, ok({ name: 'Engineering auto-assign' })], async () =>
      deploy(deployContext({ sections: [rule()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/returned no id/)
  })

  it('deactivates an active rule before the PUT, then restores the desired status', async () => {
    await withFetch([ok([LIVE_RULE]), ok({}), ok({}), ok({})], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [rule({ expression: 'user.department=="Platform"' })] }),
      )

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(3)
      expect(writes[0].path).toBe('/groups/rules/0prLIVE/lifecycle/deactivate')
      expect(writes[1].method).toBe('PUT')
      expect(writes[1].path).toBe('/groups/rules/0prLIVE')
      expect(writes[2].path).toBe('/groups/rules/0prLIVE/lifecycle/activate')
    })
  })

  it('skips the deactivate when the live rule is already INACTIVE', async () => {
    await withFetch([ok([{ ...LIVE_RULE, status: 'INACTIVE' }]), ok({}), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [rule()] }))

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.path.includes('/lifecycle/deactivate'))).toBe(false)
      expect(calls.some((c) => c.path.includes('/lifecycle/activate'))).toBe(true)
    })
  })

  it('leaves an INACTIVE rule inactive when the canvas asks for INACTIVE', async () => {
    await withFetch([ok([{ ...LIVE_RULE, status: 'INACTIVE' }]), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [rule({ status: 'INACTIVE' })] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('PUT')
    })
  })

  it('echoes the LIVE group-id ordering back on an in-place update', async () => {
    await withFetch(
      [ok([{ ...LIVE_RULE, actions: { assignUserToGroups: { groupIds: ['00gA', '00gB'] } } }]), ok({}), ok({}), ok({})],
      async (calls) => {
        const result = await deploy(
          deployContext({ sections: [rule({ groupIds: ['00gB', '00gA'] })] }),
        )

        expect(result.success).toBe(true)
        const put = writeCalls(calls).find((c) => c.method === 'PUT')
        const actions = put?.json.actions as { assignUserToGroups: { groupIds: string[] } }
        expect(actions.assignUserToGroups.groupIds).toEqual(['00gA', '00gB'])
        // Same SET — never a destructive rebuild.
        expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
      },
    )
  })

  it('captures the prior rule body so rollback can restore an in-place update', async () => {
    const result = await withFetch([ok([LIVE_RULE]), ok({}), ok({}), ok({})], async () =>
      deploy(deployContext({ sections: [rule({ expression: 'user.department=="Platform"' })] })),
    )

    const entry = (result.rollbackData as { previousState: Array<Record<string, unknown>> })
      .previousState[0]
    expect(entry.action).toBe('updated')
    expect(entry.liveId).toBe('0prLIVE')
    expect(entry.prior).toEqual(LIVE_RULE)
  })

  it('rebuilds a rule whose target groups changed — the actions block is immutable', async () => {
    const result = await withFetch(
      [ok([LIVE_RULE]), ok({}), ok({}), ok({ id: '0prREBUILT' }), ok({})],
      async (calls) => {
        const res = await deploy(deployContext({ sections: [rule({ groupIds: ['00gOTHER'] })] }))

        expect(res.success).toBe(true)
        const writes = writeCalls(calls)
        expect(writes).toHaveLength(4)
        // Deactivate first — a rule must be INACTIVE before it can be deleted.
        expect(writes[0].path).toBe('/groups/rules/0prLIVE/lifecycle/deactivate')
        expect(writes[1].method).toBe('DELETE')
        expect(writes[1].path).toBe('/groups/rules/0prLIVE')
        expect(writes[2].method).toBe('POST')
        expect(writes[2].path).toBe('/groups/rules')
        const actions = writes[2].json.actions as { assignUserToGroups: { groupIds: string[] } }
        expect(actions.assignUserToGroups.groupIds).toEqual(['00gOTHER'])
        expect(writes[3].path).toBe('/groups/rules/0prREBUILT/lifecycle/activate')
        // No PUT — a PUT could never have applied this change.
        expect(calls.some((c) => c.method === 'PUT')).toBe(false)
        return res
      },
    )

    expect(result.message).toMatch(/rebuilt/)
    const rb = result.rollbackData as {
      previousState: Array<Record<string, unknown>>
      createdRuleIds: string[]
    }
    expect(rb.previousState[0].action).toBe('rebuilt')
    expect(rb.previousState[0].liveId).toBe('0prREBUILT')
    expect(rb.previousState[0].prior).toEqual(LIVE_RULE)
    expect(rb.createdRuleIds).toEqual(['0prREBUILT'])
  })

  it('records the rebuild target BEFORE deleting, so a failed recreate is still revertible', async () => {
    const result = await withFetch(
      [ok([LIVE_RULE]), ok({}), ok({}), apiError('Api validation failed: groupIds', 400)],
      async () => deploy(deployContext({ sections: [rule({ groupIds: ['00gBAD'] })] })),
    )

    expect(result.success).toBe(false)
    const rb = result.rollbackData as { previousState: Array<Record<string, unknown>> }
    expect(rb.previousState).toHaveLength(1)
    expect(rb.previousState[0].action).toBe('rebuilt')
    expect(rb.previousState[0].prior).toEqual(LIVE_RULE)
    // The recreate never happened, so there is no new id to delete.
    expect(rb.previousState[0].liveId).toBeUndefined()
  })

  it('tolerates a 400 on the pre-delete deactivate — the rule was already inactive', async () => {
    await withFetch(
      [
        ok([{ ...LIVE_RULE, status: 'INACTIVE' }]),
        apiError('Rule is not active', 400),
        ok({}),
        ok({ id: '0prREBUILT' }),
        ok({}),
      ],
      async () => {
        const result = await deploy(deployContext({ sections: [rule({ groupIds: ['00gOTHER'] })] }))
        expect(result.success).toBe(true)
      },
    )
  })

  it('refuses to touch a system-managed rule and writes nothing', async () => {
    const result = await withFetch([ok([{ ...LIVE_RULE, system: true }])], async (calls) => {
      const res = await deploy(deployContext({ sections: [rule()] }))
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/system-managed and cannot be modified/)
  })

  it('returns a FAILED result rather than throwing when the rule list is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async (calls) => {
      const res = await deploy(deployContext({ sections: [rule()] }))
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to list group rules/)
    expect(result.message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when Okta rejects the expression', async () => {
    const result = await withFetch(
      [EMPTY_LIST, apiError('Api validation failed', 400, ['condition: expression is not a Boolean'])],
      async () => deploy(deployContext({ sections: [rule({ expression: 'user.firstName' })] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/0 of 1/)
    expect(result.message).toMatch(/not a Boolean/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result when the activation is rejected, keeping the created id', async () => {
    const result = await withFetch(
      [EMPTY_LIST, ok({ id: '0prNEW' }), apiError('Invalid rule expression', 400)],
      async () => deploy(deployContext({ sections: [rule()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to activate group rule/)
    // The rule WAS created — rollback must still be able to remove it.
    expect((result.rollbackData as { createdRuleIds: string[] }).createdRuleIds).toEqual(['0prNEW'])
  })

  it('reports partial progress when a later rule fails', async () => {
    const result = await withFetch(
      [EMPTY_LIST, ok({ id: '0prONE' }), ok({}), apiError('Insufficient permissions', 403)],
      async () =>
        deploy(
          deployContext({
            sections: [rule(), { ...rule({ name: 'Sales auto-assign' }), name: 'Sales section' }],
          }),
        ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
    // Only the rule that was actually created is recorded — a rejected create
    // left nothing behind to revert.
    const rb = result.rollbackData as { previousState: unknown[]; createdRuleIds: string[] }
    expect(rb.previousState).toHaveLength(1)
    expect(rb.createdRuleIds).toEqual(['0prONE'])
  })

  it('skips a section missing a name, an expression or a target group', async () => {
    await withFetch([EMPTY_LIST], async (calls) => {
      const result = await deploy(
        deployContext({
          sections: [
            rule({ name: '' }),
            rule({ expression: '' }),
            rule({ groupIds: [] }),
          ],
        }),
      )

      expect(result.success).toBe(true)
      expect(writeCalls(calls)).toHaveLength(0)
    })
  })

  it('does not depend on the platform data API to resolve a rule', async () => {
    await withFetch([EMPTY_LIST, ok({ id: '0prNEW' }), ok({})], async () => {
      const result = await deploy(deployContext({ sections: [rule()], platformThrows: true }))
      expect(result.success).toBe(true)
    })
  })

  it('never touches a rule that is not declared in the canvas', async () => {
    const other = { ...LIVE_RULE, id: '0prOTHER', name: 'Someone else rule' }
    await withFetch([ok([other, LIVE_RULE]), ok({}), ok({}), ok({})], async (calls) => {
      await deploy(deployContext({ sections: [rule({ expression: 'user.department=="Platform"' })] }))

      expect(calls.some((c) => c.path.includes('0prOTHER'))).toBe(false)
    })
  })

  it('treats a 404 on the rebuild delete as already gone', async () => {
    await withFetch(
      [ok([LIVE_RULE]), ok({}), notFound(), ok({ id: '0prREBUILT' }), ok({})],
      async () => {
        const result = await deploy(deployContext({ sections: [rule({ groupIds: ['00gOTHER'] })] }))
        expect(result.success).toBe(true)
      },
    )
  })
})
