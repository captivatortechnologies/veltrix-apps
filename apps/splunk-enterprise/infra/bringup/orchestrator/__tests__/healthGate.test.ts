// =============================================================================
// Unit tests for the PURE health-gate evaluation (healthEval.ts).
//
// Run with the Node built-in test runner via the repo's ts-node ESM loader:
//   node --loader ts-node/esm --test src/services/splunk/__tests__/healthGate.test.ts
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateIndexerCluster,
  evaluatePoll,
  evaluateShc,
  splunkFlag,
  PollInput,
} from '../healthEval.js';

function greenPoll(): PollInput {
  return {
    indexerClusterEnabled: true,
    shcEnabled: true,
    managerInfo: { replication_factor_met: 1, search_factor_met: 1 },
    peers: [
      { label: 'idx1', status: 'Up' },
      { label: 'idx2', status: 'Up' },
      { label: 'idx3', status: 'Up' },
    ],
    expectedPeerCount: 3,
    captainInfo: { service_ready_flag: 1 },
    shcMembers: [{ label: 'sh1' }, { label: 'sh2' }, { label: 'sh3' }],
    expectedShcMemberCount: 3,
    searchPeers: [
      { label: 'idx1', status: 'Up' },
      { label: 'idx2', status: 'Up' },
      { label: 'idx3', status: 'Up' },
    ],
  };
}

test('splunkFlag coerces 1/"1"/true but not 0/"0"/undefined', () => {
  assert.equal(splunkFlag(1), true);
  assert.equal(splunkFlag('1'), true);
  assert.equal(splunkFlag(true), true);
  assert.equal(splunkFlag(0), false);
  assert.equal(splunkFlag('0'), false);
  assert.equal(splunkFlag(undefined), false);
});

test('indexer_cluster NOT ready when replication_factor_met=0', () => {
  const g = evaluateIndexerCluster(
    { replication_factor_met: 0, search_factor_met: 1 },
    [
      { label: 'idx1', status: 'Up' },
      { label: 'idx2', status: 'Up' },
      { label: 'idx3', status: 'Up' },
    ],
    3,
  );
  assert.equal(g.ready, false);
  assert.match(g.detail, /replication_factor_met=0/);
});

test('indexer_cluster NOT ready when a peer is Down', () => {
  const g = evaluateIndexerCluster(
    { replication_factor_met: 1, search_factor_met: 1 },
    [
      { label: 'idx1', status: 'Up' },
      { label: 'idx2', status: 'Down' },
      { label: 'idx3', status: 'Up' },
    ],
    3,
  );
  assert.equal(g.ready, false);
  assert.match(g.detail, /down=\[idx2\]/);
});

test('indexer_cluster NOT reachable => not ready with a clear detail', () => {
  const g = evaluateIndexerCluster(null, [], 3);
  assert.equal(g.ready, false);
  assert.match(g.detail, /not reachable/);
});

test('indexer_cluster ready when both factors met and all peers Up', () => {
  const g = evaluateIndexerCluster(
    { replication_factor_met: 1, search_factor_met: 1 },
    [
      { label: 'idx1', status: 'Up' },
      { label: 'idx2', status: 'Up' },
      { label: 'idx3', status: 'Up' },
    ],
    3,
  );
  assert.equal(g.ready, true);
});

test('shc NOT ready when service_ready_flag=0', () => {
  const g = evaluateShc({ service_ready_flag: 0 }, [{ label: 'sh1' }, { label: 'sh2' }, { label: 'sh3' }], 3);
  assert.equal(g.ready, false);
  assert.match(g.detail, /service_ready_flag=0/);
});

test('shc NOT ready when members below expected count', () => {
  const g = evaluateShc({ service_ready_flag: 1 }, [{ label: 'sh1' }, { label: 'sh2' }], 3);
  assert.equal(g.ready, false);
  assert.match(g.detail, /members=2\/3/);
});

test('shc ready when captain service_ready_flag=1 and members present', () => {
  const g = evaluateShc({ service_ready_flag: 1 }, [{ label: 'sh1' }, { label: 'sh2' }, { label: 'sh3' }], 3);
  assert.equal(g.ready, true);
});

test('evaluatePoll green: all factors met + peers Up + captain ready => ready', () => {
  const r = evaluatePoll(greenPoll());
  assert.equal(r.ready, true);
  assert.equal(r.failedGate, undefined);
  assert.deepEqual(
    r.gates.map((g) => g.name),
    ['indexer_cluster', 'search_head_cluster', 'search_peers'],
  );
});

test('evaluatePoll names the first failing gate (indexer_cluster) on rf=0', () => {
  const poll = greenPoll();
  poll.managerInfo = { replication_factor_met: 0, search_factor_met: 1 };
  const r = evaluatePoll(poll);
  assert.equal(r.ready, false);
  assert.equal(r.failedGate, 'indexer_cluster');
});

test('evaluatePoll only gates topologies that exist (indexer-only, no SHC)', () => {
  const poll = greenPoll();
  poll.shcEnabled = false;
  poll.captainInfo = null;
  poll.shcMembers = [];
  const r = evaluatePoll(poll);
  assert.equal(r.ready, true);
  assert.deepEqual(
    r.gates.map((g) => g.name),
    ['indexer_cluster'],
  );
});

test('evaluatePoll not ready when there are no applicable gates', () => {
  const poll = greenPoll();
  poll.indexerClusterEnabled = false;
  poll.shcEnabled = false;
  const r = evaluatePoll(poll);
  assert.equal(r.ready, false);
  assert.equal(r.gates.length, 0);
});
