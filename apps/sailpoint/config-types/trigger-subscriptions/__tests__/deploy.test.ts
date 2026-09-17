// deploy for ISC event trigger subscriptions.
//
// A trigger subscription is an outbound webhook. `httpConfig` carries the endpoint
// secret and is masked on read, so the patch writes it blind; `enabled` and `filter`
// decide whether anything is delivered at all, and those are what rollback restores.

import assert from 'node:assert/strict'
import { registerCollectionDeployContract } from '../../../lib/__tests__/collectionContracts'
import deploy from '../deploy'
import { LIVE_ID, NAME, PRIOR, liveTriggerSubscription, subscriptionItem } from './fixtures'

registerCollectionDeployContract({
  label: 'trigger-subscriptions',
  handler: deploy,
  listPath: '/beta/trigger-subscriptions',
  createPath: '/beta/trigger-subscriptions',
  updatePath: '/beta/trigger-subscriptions/ts-3c44ef',
  updateMethod: 'PATCH',
  item: subscriptionItem(),
  live: liveTriggerSubscription(),
  createBodyIncludes: ['Joiner Webhook', 'idn:identity-created', 'hooks.example.test', '"httpConfig"'],
  updateBodyIncludes: ['$.identity.attributes.cloudLifecycleState', 'hooks.example.test'],
  assertCreatedEntry: (entry) => {
    assert.equal(entry.id, 'created-1')
  },
  assertPrior: (entry) => {
    assert.equal(entry.id, LIVE_ID)
    assert.equal(entry.name, NAME)
    assert.deepEqual(entry.prior, PRIOR)
  },
  reconcile: {
    priorEntry: { name: 'Retired Webhook', existed: false, id: 'ts-retired' },
    deletePath: '/beta/trigger-subscriptions/ts-retired',
  },
})
