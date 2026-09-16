// ============================================================================
// `description` must be WRITTEN, not just collected and diffed.
//
// The canvas offers a Description field, `extractGroupSpecs` read it into the
// spec, and `driftDetect` diffed it against the live group — but deploy sent
// only `{ name, inherits }`. Anyone who filled Description in got permanent,
// unremediable informational drift: every scheduled run reported
// `<group>.description expected "<text>" actual "not set"`, and no deploy could
// ever converge it. `s1-groups` was the only configuration type in this app with
// that write/drift asymmetry.
//
// The field is sent only when the author supplied one, so a canvas that leaves
// it blank produces a byte-identical body to before the fix.
// ============================================================================

import deploy, { type GroupRollbackEntry } from '../deploy'
import rollback from '../rollback'
import {
  SITE_SETTINGS,
  callsTo,
  dataOf,
  deployContext,
  rollbackContext,
  envelope,
  withFetch,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeS1'

const CONFIG_TYPE = 's1-groups'

function ctx(sections: CanvasItemInput[]) {
  return deployContext({ configTypeId: CONFIG_TYPE, sections, settings: SITE_SETTINGS })
}

function group(fields: Record<string, unknown>): CanvasItemInput {
  return { name: `Group ${String(fields.name ?? '')}`, fields }
}

function previousState(result: { rollbackData?: unknown }): GroupRollbackEntry[] {
  return (result.rollbackData as { previousState?: GroupRollbackEntry[] } | undefined)?.previousState ?? []
}

describe('s1-groups description is written', () => {
  it('sends the description when creating a group', async () => {
    await withFetch([envelope([]), envelope({ id: 'grp-new' })], async (calls) => {
      const result = await deploy(
        ctx([group({ name: 'Servers', inherits: true, description: 'Production web tier' })]),
      )

      expect(result.success).toBe(true)
      const posts = callsTo(calls, '/groups').filter((c) => c.method === 'POST')
      expect(posts).toHaveLength(1)
      expect((dataOf(posts[0]) as Record<string, unknown>).description).toBe('Production web tier')
    })
  })

  it('sends the description when updating an existing group', async () => {
    await withFetch(
      [envelope([{ id: 'grp-1', name: 'Servers', inherits: true }]), envelope({})],
      async (calls) => {
        const result = await deploy(
          ctx([group({ name: 'Servers', inherits: true, description: 'Now documented' })]),
        )

        expect(result.success).toBe(true)
        const puts = callsTo(calls, '/groups/grp-1')
        expect((dataOf(puts[0]) as Record<string, unknown>).description).toBe('Now documented')
      },
    )
  })

  it('omits the field entirely when the author left it blank', async () => {
    // The compatibility guarantee: an existing canvas produces the same body it
    // always did, so this fix cannot change what is sent for anyone who never
    // used the field.
    await withFetch([envelope([]), envelope({ id: 'grp-new' })], async (calls) => {
      await deploy(ctx([group({ name: 'Servers', inherits: true })]))

      const posts = callsTo(calls, '/groups').filter((c) => c.method === 'POST')
      expect('description' in (dataOf(posts[0]) as Record<string, unknown>)).toBe(false)
    })
  })

  it('records the LIVE description as prior state, not the desired one', async () => {
    // Rollback restores what was there before, so the captured value has to come
    // from the live group.
    await withFetch(
      [
        envelope([{ id: 'grp-1', name: 'Servers', inherits: true, description: 'Old text' }]),
        envelope({}),
      ],
      async () => {
        const result = await deploy(
          ctx([group({ name: 'Servers', inherits: true, description: 'New text' })]),
        )

        expect(previousState(result)[0].prior?.description).toBe('Old text')
      },
    )
  })

  it('records an empty string when the live group had no description', async () => {
    // Not undefined: rollback must be able to tell "had none" from "not
    // recorded", or it cannot clear a description this deploy added.
    await withFetch(
      [envelope([{ id: 'grp-1', name: 'Servers', inherits: true }]), envelope({})],
      async () => {
        const result = await deploy(
          ctx([group({ name: 'Servers', inherits: true, description: 'Added now' })]),
        )

        expect(previousState(result)[0].prior?.description).toBe('')
      },
    )
  })
})

describe('s1-groups rollback restores the description', () => {
  it('puts back the prior text', async () => {
    const entry: GroupRollbackEntry = {
      name: 'Servers',
      existed: true,
      id: 'grp-1',
      prior: { name: 'Servers', inherits: true, description: 'Old text' },
    }

    await withFetch([envelope({})], async (calls) => {
      const result = await rollback(
        // rollbackContext takes the rollback DATA first and options second.
        rollbackContext(
          { previousState: [entry], createdIds: [] },
          { configTypeId: CONFIG_TYPE, settings: SITE_SETTINGS },
        ),
      )

      expect(result.success).toBe(true)
      expect((dataOf(calls[0]) as Record<string, unknown>).description).toBe('Old text')
    })
  })

  it('clears a description the deploy added, rather than leaving it behind', async () => {
    // The case that makes the empty string matter: without it, rollback would
    // report success while the group kept the new description.
    const entry: GroupRollbackEntry = {
      name: 'Servers',
      existed: true,
      id: 'grp-1',
      prior: { name: 'Servers', inherits: true, description: '' },
    }

    await withFetch([envelope({})], async (calls) => {
      await rollback(
        // rollbackContext takes the rollback DATA first and options second.
        rollbackContext(
          { previousState: [entry], createdIds: [] },
          { configTypeId: CONFIG_TYPE, settings: SITE_SETTINGS },
        ),
      )

      expect((dataOf(calls[0]) as Record<string, unknown>).description).toBe('')
    })
  })
})
