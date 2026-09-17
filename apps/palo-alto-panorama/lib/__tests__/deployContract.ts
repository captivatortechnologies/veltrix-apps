// =============================================================================
// The `deploy` contract every Panorama configuration type must satisfy.
//
// Deploy is: GET the resource's collection at the configured location, then POST
// (create) or PUT (update) one entry per canvas item, then — only when
// `auto_commit` is on — commit the candidate configuration over the XML API and
// poll the job.
//
// What makes that worth asserting rather than assuming:
//
//   * The UPDATE path is the one that silently overwrites. Whether a POST or a
//     PUT goes out is decided entirely by whether the object's name came back in
//     the listing, so both branches are driven here with the same fixture.
//
//   * The device group is the blast radius. Every call must carry
//     `location=device-group&device-group=<name>`; drop it and a rule set lands
//     in `shared`, which every device group inherits.
//
//   * A write that succeeded must be recoverable BEFORE anything else can throw.
//     The object exists in the customer's candidate config the moment the POST
//     returns, so a second item that fails, or a commit that is refused, must
//     still hand back rollback state naming what was created.
//
//   * A commit is refused INSIDE a 200. `<response status="error">` at HTTP 200
//     is how a commit lock or a config error arrives; a deploy that reads only
//     the HTTP status reports a configuration as live on the firewalls when
//     nothing was activated.
// =============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  API_KEY,
  CREDENTIAL_WITHOUT_KEY,
  COMMIT_NO_CHANGES,
  COMPONENT_WITHOUT_HOSTNAME,
  DEVICE_GROUP,
  REST_BASE,
  WRITE_OK,
  assertScopedAndAuthenticated,
  commitCalls,
  commitJobFinished,
  commitQueued,
  commitRejected,
  deployContext,
  leaksSecret,
  listOk,
  listSingle,
  restCalls,
  restError,
  withPanorama,
  withUnreachablePanorama,
  xmlCalls,
} from './fakePanorama'
import { livePriorEntry, type ConfigFixture } from './configFixture'

type DeployHandler = (ctx: DeployContext) => Promise<DeployResult>

interface PanoramaRollbackData {
  rollback?: Array<{ name: string; existed: boolean }>
  resourcePath?: string
}

function rollbackOf(result: DeployResult): PanoramaRollbackData {
  return (result.rollbackData ?? {}) as PanoramaRollbackData
}

/** Register the deploy contract suite for one configuration type. */
export function describeDeployContract(fx: ConfigFixture, deploy: DeployHandler): void {
  const label = `panorama ${fx.id} deploy`

  test(`${label} fixture describes a live object that really differs from the canvas`, () => {
    const desired = JSON.stringify(fx.fields)
    const live = JSON.stringify(fx.livePrior)
    assert.ok(
      desired.includes(fx.canvasOnlyValue),
      'canvasOnlyValue must be something the canvas actually asks for',
    )
    assert.ok(
      !live.includes(fx.canvasOnlyValue),
      'canvasOnlyValue must be absent from the live object, or nothing distinguishes desired from prior',
    )
    assert.ok(live.includes(fx.liveOnlyValue), 'liveOnlyValue must be something the live object actually has')
    assert.ok(!desired.includes(fx.liveOnlyValue), 'liveOnlyValue must be absent from the desired fields')
  })

  test(`${label} refuses before touching Panorama when no credential is configured`, async () => {
    await withPanorama([], async (calls) => {
      const result = await deploy(deployContext([fx.item], { credential: null }))

      assert.equal(result.success, false)
      assert.match(result.message, /No Panorama API key/)
      assert.equal(calls.length, 0, 'a config type with no credential must not reach the customer’s Panorama')
    })
  })

  test(`${label} refuses before touching Panorama when the credential carries no key`, async () => {
    await withPanorama([], async (calls) => {
      const result = await deploy(deployContext([fx.item], { credential: CREDENTIAL_WITHOUT_KEY }))

      assert.equal(result.success, false)
      assert.match(result.message, /No Panorama API key/)
      assert.equal(calls.length, 0)
    })
  })

  test(`${label} refuses before touching Panorama when the component has no hostname`, async () => {
    await withPanorama([], async (calls) => {
      const result = await deploy(deployContext([fx.item], { component: COMPONENT_WITHOUT_HOSTNAME }))

      assert.equal(result.success, false)
      assert.match(result.message, /No Panorama host/)
      assert.equal(calls.length, 0)
    })
  })

  test(`${label} creates the object when the device group does not have it`, async () => {
    await withPanorama([listOk([]), WRITE_OK], async (calls) => {
      const result = await deploy(deployContext([fx.item]))

      assertScopedAndAuthenticated(assert, calls)
      assert.equal(calls.length, 2, 'one listing then one write — no extra reads of the customer’s config')

      assert.equal(calls[0].method, 'GET')
      assert.equal(calls[0].resourcePath, fx.resourcePath)
      assert.equal(calls[0].hasName, false, 'the listing is of the collection, not one object')

      const write = calls[1]
      assert.equal(write.method, 'POST', 'an object that is not there is created, not updated')
      assert.equal(write.url.startsWith(`${REST_BASE}${fx.resourcePath}?`), true)
      assert.equal(write.name, fx.name, 'the object is addressed by name in the query string')
      assert.equal(write.entryName, fx.name)
      assert.equal(write.entryLocation, 'device-group')
      assert.equal(write.entryDeviceGroup, DEVICE_GROUP)
      assert.deepEqual(write.fields, fx.fields)

      assert.equal(result.success, true)
      assert.match(result.message, new RegExp(`Deployed 1 ${escape(fx.typeLabel)}`))
      assert.match(result.message, /DG-Edge/)
      assert.deepEqual(result.artifacts?.deployed, [fx.name])
      assert.equal(result.artifacts?.panoramaUrl, 'https://panorama.example.com')

      const data = rollbackOf(result)
      assert.equal(data.resourcePath, fx.resourcePath)
      assert.deepEqual(data.rollback, [{ name: fx.name, existed: false }])
      assert.equal(leaksSecret(result), false)
    })
  })

  test(`${label} updates the object when the device group already has it`, async () => {
    await withPanorama([listOk([livePriorEntry(fx)]), WRITE_OK], async (calls) => {
      const result = await deploy(deployContext([fx.item]))

      const write = restCalls(calls)[1]
      assert.equal(write.method, 'PUT', 'an object that is already there is updated, not created again')
      assert.equal(write.name, fx.name)
      assert.deepEqual(write.fields, fx.fields)

      assert.equal(result.success, true)
      const data = rollbackOf(result)
      assert.deepEqual(data.rollback, [{ name: fx.name, existed: true }])
    })
  })

  test(`${label} recognises the object when Panorama returns the single-entry shape`, async () => {
    await withPanorama([listSingle(livePriorEntry(fx)), WRITE_OK], async (calls) => {
      const result = await deploy(deployContext([fx.item]))

      assert.equal(
        restCalls(calls)[1].method,
        'PUT',
        'a collection of one comes back as a bare object; reading it as "nothing there" creates a duplicate',
      )
      assert.equal(result.success, true)
    })
  })

  test(`${label} matches an existing object case-insensitively`, async () => {
    const shouty = livePriorEntry(fx)
    shouty['@name'] = fx.name.toUpperCase()

    await withPanorama([listOk([shouty]), WRITE_OK], async (calls) => {
      await deploy(deployContext([fx.item]))

      assert.equal(restCalls(calls)[1].method, 'PUT', 'PAN-OS object names are matched case-insensitively')
    })
  })

  test(`${label} does not record the value it wanted as if it were the prior state`, async () => {
    await withPanorama([listOk([livePriorEntry(fx)]), WRITE_OK], async () => {
      const result = await deploy(deployContext([fx.item]))

      const recorded = JSON.stringify(result.rollbackData ?? null)
      assert.ok(
        !recorded.includes(fx.canvasOnlyValue),
        'rollback state must describe what was there, never what the canvas asked for',
      )
    })
  })

  test(`${label} leaves the candidate config uncommitted when auto_commit is off`, async () => {
    await withPanorama([listOk([]), WRITE_OK], async (calls) => {
      const result = await deploy(deployContext([fx.item]))

      assert.equal(xmlCalls(calls).length, 0, 'auto_commit off must not activate anything')
      assert.equal(result.artifacts?.committed, false)
      assert.equal(result.artifacts?.commitJobId, null)
      assert.match(result.message, /NOT committed/)
    })
  })

  test(`${label} commits and waits for the job when auto_commit is on`, async () => {
    await withPanorama(
      [listOk([]), WRITE_OK, commitQueued('4242'), commitJobFinished('4242', 'OK')],
      async (calls) => {
        const result = await deploy(deployContext([fx.item], { autoCommit: true }))

        assertScopedAndAuthenticated(assert, calls)
        const xml = xmlCalls(calls)
        assert.equal(xml.length, 2, 'one commit, one job poll')
        assert.equal(xml[0].method, 'POST')
        assert.equal(xml[0].xmlType, 'commit')
        assert.equal(xml[0].xmlCmd, '<commit></commit>')
        assert.equal(xml[1].xmlType, 'op')
        assert.equal(xml[1].xmlCmd, '<show><jobs><id>4242</id></jobs></show>', 'the enqueued job is the one polled')

        assert.equal(result.success, true)
        assert.equal(result.artifacts?.committed, true)
        assert.equal(result.artifacts?.commitJobId, '4242')
        assert.match(result.message, /job 4242/)
      },
    )
  })

  test(`${label} commits once, after every object is written`, async () => {
    await withPanorama(
      [listOk([]), WRITE_OK, WRITE_OK, commitQueued('7'), commitJobFinished('7', 'OK')],
      async (calls) => {
        const result = await deploy(deployContext([fx.item, fx.secondItem], { autoCommit: true }))

        const writes = restCalls(calls).filter((c) => c.method !== 'GET')
        assert.deepEqual(
          writes.map((c) => c.name),
          [fx.name, fx.secondName],
          'objects are written in canvas order',
        )
        assert.deepEqual(writes[0].fields, fx.fields)
        assert.deepEqual(writes[1].fields, fx.secondFields)

        const commits = commitCalls(calls)
        assert.equal(commits.length, 1, 'one commit for the whole deploy, not one per object')
        assert.equal(calls.indexOf(commits[0]) > calls.indexOf(writes[1]), true, 'the commit comes after the writes')
        assert.equal(result.success, true)
        assert.deepEqual(result.artifacts?.deployed, [fx.name, fx.secondName])
      },
    )
  })

  test(`${label} lists the collection once, not once per object`, async () => {
    await withPanorama([listOk([]), WRITE_OK, WRITE_OK], async (calls) => {
      await deploy(deployContext([fx.item, fx.secondItem]))

      assert.equal(restCalls(calls).filter((c) => c.method === 'GET').length, 1)
    })
  })

  test(`${label} fails the deploy rather than throwing when Panorama refuses the write`, async () => {
    await withPanorama([listOk([]), restError(400, 'vsys is not a valid value for device group')], async (calls) => {
      const result = await deploy(deployContext([fx.item]))

      assert.equal(result.success, false)
      assert.match(result.message, /Failed to create/)
      assert.match(result.message, /vsys is not a valid value/)
      assert.equal(commitCalls(calls).length, 0, 'a failed write must not leave a commit queued')
      assert.equal(leaksSecret(result), false)
    })
  })

  test(`${label} fails the deploy rather than throwing when the listing is refused`, async () => {
    await withPanorama([restError(403, 'Permission denied for this device group')], async (calls) => {
      const result = await deploy(deployContext([fx.item]))

      assert.equal(result.success, false)
      assert.match(result.message, /Failed to list existing objects/)
      assert.match(result.message, /Permission denied/)
      assert.equal(calls.length, 1, 'nothing is written once the read failed')
      assert.equal(leaksSecret(result), false)
    })
  })

  test(`${label} still hands back what it created when a later object fails`, async () => {
    await withPanorama([listOk([]), WRITE_OK, restError(400, 'name is already in use')], async () => {
      const result = await deploy(deployContext([fx.item, fx.secondItem]))

      assert.equal(result.success, false)
      assert.match(result.message, /deploy failed after 1 of 2/)
      assert.deepEqual(result.artifacts?.deployed, [fx.name])

      const data = rollbackOf(result)
      assert.equal(data.resourcePath, fx.resourcePath)
      assert.deepEqual(
        data.rollback,
        [{ name: fx.name, existed: false }],
        'the first object exists in the candidate config — a failure path that dropped this leaves it orphaned',
      )
    })
  })

  test(`${label} treats a commit refused inside a 200 as a failed deploy`, async () => {
    await withPanorama(
      [listOk([]), WRITE_OK, commitRejected('Commit lock is held by admin2')],
      async (calls) => {
        const result = await deploy(deployContext([fx.item], { autoCommit: true }))

        assert.equal(result.success, false, 'HTTP 200 with status="error" is a refusal, not an activation')
        assert.match(result.message, /Commit rejected/)
        assert.match(result.message, /Commit lock is held by admin2/)
        assert.equal(xmlCalls(calls).length, 1, 'a refused commit enqueues no job to poll')

        const data = rollbackOf(result)
        assert.deepEqual(
          data.rollback,
          [{ name: fx.name, existed: false }],
          'the object is in the candidate config even though the commit failed — rollback needs to know',
        )
        assert.equal(leaksSecret(result), false)
      },
    )
  })

  test(`${label} treats a commit job that finished FAILED as a failed deploy`, async () => {
    await withPanorama(
      [listOk([]), WRITE_OK, commitQueued('99'), commitJobFinished('99', 'FAIL')],
      async () => {
        const result = await deploy(deployContext([fx.item], { autoCommit: true }))

        assert.equal(result.success, false)
        assert.match(result.message, /job 99 finished with result FAIL/)
        assert.deepEqual(rollbackOf(result).rollback, [{ name: fx.name, existed: false }])
      },
    )
  })

  test(`${label} reports a commit that had nothing to activate`, async () => {
    await withPanorama([listOk([livePriorEntry(fx)]), WRITE_OK, COMMIT_NO_CHANGES], async (calls) => {
      const result = await deploy(deployContext([fx.item], { autoCommit: true }))

      assert.equal(result.success, true)
      assert.match(result.message, /no changes were queued/)
      assert.equal(xmlCalls(calls).length, 1, 'nothing was enqueued, so there is no job to poll')
    })
  })

  test(`${label} fails the deploy rather than throwing when Panorama is unreachable`, async () => {
    await withUnreachablePanorama(async (calls) => {
      const result = await deploy(deployContext([fx.item]))

      assert.equal(result.success, false)
      assert.match(result.message, /ECONNREFUSED/)
      assert.equal(calls.length, 1, 'the listing is attempted once and the failure ends the deploy')
      assert.equal(leaksSecret(result), false)
    })
  })

  test(`${label} writes to the shared location only when the operator asked for it`, async () => {
    await withPanorama([listOk([]), WRITE_OK], async (calls) => {
      const result = await deploy(deployContext([fx.item], { deviceGroup: 'shared' }))

      for (const call of restCalls(calls)) {
        assert.equal(call.location, 'shared')
        assert.equal(call.deviceGroup, '', 'the shared location carries no device-group param')
      }
      assert.equal(restCalls(calls)[1].entryDeviceGroup, '')
      assert.match(result.message, /\(shared\)/)
    })
  })

  test(`${label} never puts the API key in a message, an artifact or rollbackData`, async () => {
    await withPanorama(
      [listOk([]), WRITE_OK, commitQueued('4242'), commitJobFinished('4242', 'OK')],
      async (calls) => {
        const result = await deploy(deployContext([fx.item], { autoCommit: true }))

        assert.equal(result.success, true)
        assert.equal(calls[1].apiKey, API_KEY, 'the key travels in the X-PAN-KEY header, where it belongs')
        assert.equal(
          leaksSecret(result),
          false,
          'everything returned here is stored on the deployment record and shown to operators',
        )
      },
    )
  })
}

/** Escape a fixture's noun for use inside a RegExp — "(s)" is not a group. */
function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
