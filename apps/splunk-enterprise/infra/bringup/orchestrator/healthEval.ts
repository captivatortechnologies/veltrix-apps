// =============================================================================
// Splunk health-gate evaluation — PURE logic (single source of truth).
//
// The health-gate.mjs CLI does the polling + TLS HTTP + backoff; this module
// does the "is this one poll green?" decision so it is trivially unit-testable.
// No I/O, no clock, no randomness — deterministic evaluation of parsed content.
//
// Splunk REST (output_mode=json) wraps results as { entry: [{ name, content }] }.
// The CLI extracts the relevant `content` objects and hands them here.
// =============================================================================

/** Coerce Splunk's 1/0 | "1"/"0" | true/false flags to a boolean. */
export function splunkFlag(value: unknown): boolean {
  return value === 1 || value === true || value === '1' || value === 'true';
}

/** `content` of GET /services/cluster/manager/info (a.k.a. master/info). */
export interface ClusterManagerInfo {
  replication_factor_met?: unknown;
  search_factor_met?: unknown;
  [k: string]: unknown;
}

/** One peer from GET /services/cluster/manager/peers. */
export interface ClusterPeer {
  label?: string;
  status?: unknown;
  [k: string]: unknown;
}

/** `content` of GET /services/shcluster/captain/info. */
export interface CaptainInfo {
  service_ready_flag?: unknown;
  maintenance_mode?: unknown;
  [k: string]: unknown;
}

/** One distributed search peer from GET /services/search/distributed/peers. */
export interface SearchPeer {
  label?: string;
  status?: unknown;
  [k: string]: unknown;
}

/** All parsed inputs for a single poll iteration. */
export interface PollInput {
  indexerClusterEnabled: boolean;
  shcEnabled: boolean;
  /** null when the CM REST call failed / not yet reachable this iteration. */
  managerInfo: ClusterManagerInfo | null;
  peers: ClusterPeer[];
  expectedPeerCount: number;
  captainInfo: CaptainInfo | null;
  /** SHC members as reported by the captain (GET /services/shcluster/captain/members). */
  shcMembers: Array<{ label?: string; status?: unknown }>;
  expectedShcMemberCount: number;
  /** Distributed search peers as seen from a search head. */
  searchPeers: SearchPeer[];
}

export interface GateStatus {
  name: string;
  ready: boolean;
  detail: string;
}

export interface PollResult {
  ready: boolean;
  gates: GateStatus[];
  /** First not-ready gate — the precise thing to report on timeout. */
  failedGate?: string;
}

/** A peer is healthy when its status is exactly "Up" (Splunk's canonical state). */
function statusUp(status: unknown): boolean {
  return typeof status === 'string' && status.toLowerCase() === 'up';
}

/** Gate 1 — indexer cluster: RF met, SF met, all peers Up, expected count present. */
export function evaluateIndexerCluster(
  managerInfo: ClusterManagerInfo | null,
  peers: ClusterPeer[],
  expectedPeerCount: number,
): GateStatus {
  const name = 'indexer_cluster';
  if (!managerInfo) {
    return { name, ready: false, detail: 'cluster-manager /cluster/manager/info not reachable yet' };
  }
  const rf = splunkFlag(managerInfo.replication_factor_met);
  const sf = splunkFlag(managerInfo.search_factor_met);
  const upPeers = peers.filter((p) => statusUp(p.status));
  const down = peers.filter((p) => !statusUp(p.status)).map((p) => p.label ?? '?');
  const countOk = expectedPeerCount <= 0 ? peers.length > 0 : upPeers.length >= expectedPeerCount;
  const ready = rf && sf && countOk && down.length === 0 && peers.length > 0;
  const detail = ready
    ? `replication_factor_met=1 search_factor_met=1 peers=${upPeers.length}/${expectedPeerCount || peers.length} Up`
    : `replication_factor_met=${rf ? 1 : 0} search_factor_met=${sf ? 1 : 0} ` +
      `peersUp=${upPeers.length}/${expectedPeerCount || peers.length}` +
      (down.length ? ` down=[${down.join(',')}]` : '');
  return { name, ready, detail };
}

/** Gate 2 — SHC: captain service_ready_flag=1 and expected members present. */
export function evaluateShc(
  captainInfo: CaptainInfo | null,
  members: Array<{ label?: string; status?: unknown }>,
  expectedMemberCount: number,
): GateStatus {
  const name = 'search_head_cluster';
  if (!captainInfo) {
    return { name, ready: false, detail: 'SHC captain /shcluster/captain/info not reachable yet' };
  }
  const serviceReady = splunkFlag(captainInfo.service_ready_flag);
  const memberOk = expectedMemberCount <= 0 ? members.length > 0 : members.length >= expectedMemberCount;
  const ready = serviceReady && memberOk;
  const detail = ready
    ? `service_ready_flag=1 members=${members.length}/${expectedMemberCount || members.length}`
    : `service_ready_flag=${serviceReady ? 1 : 0} members=${members.length}/${expectedMemberCount || members.length}`;
  return { name, ready, detail };
}

/** Gate 3 — distributed search peers all Up (SH -> indexer cluster integration). */
export function evaluateSearchPeers(peers: SearchPeer[]): GateStatus {
  const name = 'search_peers';
  const upPeers = peers.filter((p) => statusUp(p.status));
  const down = peers.filter((p) => !statusUp(p.status)).map((p) => p.label ?? '?');
  const ready = peers.length > 0 && down.length === 0;
  const detail = ready
    ? `${upPeers.length}/${peers.length} search peers Up`
    : peers.length === 0
      ? 'no distributed search peers registered yet'
      : `searchPeersUp=${upPeers.length}/${peers.length} down=[${down.join(',')}]`;
  return { name, ready, detail };
}

/**
 * Evaluate one poll across every applicable gate. A gate is only required when
 * its topology exists (indexer cluster / SHC enabled). Pure.
 */
export function evaluatePoll(input: PollInput): PollResult {
  const gates: GateStatus[] = [];
  if (input.indexerClusterEnabled) {
    gates.push(evaluateIndexerCluster(input.managerInfo, input.peers, input.expectedPeerCount));
  }
  if (input.shcEnabled) {
    gates.push(evaluateShc(input.captainInfo, input.shcMembers, input.expectedShcMemberCount));
    // Search-peer integration only meaningfully gated once an SHC exists (or a
    // standalone SH is present — caller sets searchPeers accordingly).
    gates.push(evaluateSearchPeers(input.searchPeers));
  }
  const failed = gates.find((g) => !g.ready);
  return {
    ready: gates.length > 0 && !failed,
    gates,
    failedGate: failed?.name,
  };
}
