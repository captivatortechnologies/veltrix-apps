#!/usr/bin/env node
// =============================================================================
// health-gate.mjs — gate "ready" on Splunk's OWN health, not on ansible exit.
//
// Polls the splunkd REST API (8089, TLS) with exponential backoff until every
// applicable gate is green, or a hard timeout fires. Exit 0 on green; non-zero
// with a precise message naming the failing gate on timeout.
//
// The "is this poll green?" decision is the PURE evaluatePoll() in
// src/services/splunk/healthEval.ts (compiled to dist) — this file only does
// I/O + the loop, so the decision logic is unit-tested independently.
//
// Gates (each only required when its topology exists):
//   indexer_cluster    CM /services/cluster/manager/info  replication_factor_met
//                      && search_factor_met; /cluster/manager/peers all Up.
//   search_head_cluster SHC captain /services/shcluster/captain/info
//                      service_ready_flag=1 && expected members present.
//   search_peers       SH /services/search/distributed/peers all Up.
//
// Creds: SPLUNK_ADMIN_USER (default "admin") + SPLUNK_ADMIN_PASSWORD from ENV
// ONLY (never argv, never logged). CI populates these from Secrets Manager.
// TLS: internal per-node private-CA certs aren't in the system trust store, so
// the poll is insecure (-k) by default; pass --ca <pem> to pin instead.
// =============================================================================

import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// splunk/health/ -> rabbitmq/ -> dist/services/splunk/healthEval.js
const COMPILED = path.resolve(__dirname, '../../dist/services/splunk/healthEval.js');

const MGMT_PORT = 8089;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const BACKOFF_START_MS = 5000;
const BACKOFF_MAX_MS = 30000;
const BACKOFF_FACTOR = 1.5;
const REQUEST_TIMEOUT_MS = 15000;

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function bool(v, fallback = false) {
  if (v === undefined || v === null || v === '') return fallback;
  return v === 'true' || v === '1' || v === true;
}

function die(msg, code = 1) {
  console.error(`[health-gate] ERROR: ${msg}`);
  process.exit(code);
}

function pathToFileUrl(p) {
  const resolved = path.resolve(p).replace(/\\/g, '/');
  return resolved.startsWith('/') ? `file://${resolved}` : `file:///${resolved}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GET a Splunk REST endpoint as JSON. Returns { status, json } — a non-200 or a
 * network error resolves to { status, json: null } so the poll loop keeps going
 * rather than crashing on a not-yet-ready node.
 */
function getJson(host, urlPath, { user, pass, ca, insecure }) {
  return new Promise((resolve) => {
    const sep = urlPath.includes('?') ? '&' : '?';
    const options = {
      host,
      port: MGMT_PORT,
      path: `${urlPath}${sep}output_mode=json&count=0`,
      method: 'GET',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'),
        Accept: 'application/json',
      },
      timeout: REQUEST_TIMEOUT_MS,
      rejectUnauthorized: !insecure,
      ...(ca ? { ca } : {}),
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ status: res.statusCode, json: null });
        try {
          resolve({ status: 200, json: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, json: null });
        }
      });
    });
    req.on('error', () => resolve({ status: 0, json: null }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, json: null });
    });
    req.end();
  });
}

/** entry[].content array from a Splunk REST payload. */
function contents(json) {
  return Array.isArray(json?.entry) ? json.entry.map((e) => ({ label: e.name, ...e.content })) : [];
}

/** First entry's content (single-object endpoints like /manager/info). */
function firstContent(json) {
  const c = contents(json);
  return c.length ? c[0] : null;
}

/**
 * Try the modern /manager path, fall back to the legacy /master path (Splunk
 * renamed cluster-master -> cluster-manager). Returns {json} of whichever 200s.
 */
async function getClusterManager(host, urlSuffix, creds) {
  const modern = await getJson(host, `/services/cluster/manager/${urlSuffix}`, creds);
  if (modern.status === 200) return modern.json;
  const legacy = await getJson(host, `/services/cluster/master/${urlSuffix}`, creds);
  return legacy.status === 200 ? legacy.json : null;
}

/** Probe captain candidates; the real captain returns a 200 captain/info. */
async function findCaptain(candidates, creds) {
  for (const host of candidates) {
    if (!host) continue;
    const res = await getJson(host, '/services/shcluster/captain/info', creds);
    if (res.status === 200 && firstContent(res.json)) return host;
  }
  return null;
}

async function gatherPoll(targets, creds) {
  const input = {
    indexerClusterEnabled: targets.indexerClusterEnabled,
    shcEnabled: targets.shcEnabled,
    managerInfo: null,
    peers: [],
    expectedPeerCount: targets.expectedIndexers,
    captainInfo: null,
    shcMembers: [],
    expectedShcMemberCount: targets.expectedShcMembers,
    searchPeers: [],
  };

  if (targets.indexerClusterEnabled && targets.clusterManagerFqdn) {
    const info = await getClusterManager(targets.clusterManagerFqdn, 'info', creds);
    input.managerInfo = firstContent(info);
    const peers = await getClusterManager(targets.clusterManagerFqdn, 'peers', creds);
    input.peers = contents(peers);
  }

  if (targets.shcEnabled) {
    const captainHost = await findCaptain(targets.captainCandidates, creds);
    if (captainHost) {
      const info = await getJson(captainHost, '/services/shcluster/captain/info', creds);
      input.captainInfo = firstContent(info.json);
      const members = await getJson(captainHost, '/services/shcluster/captain/members', creds);
      input.shcMembers = contents(members.json);
    }
    if (targets.searchHeadFqdn) {
      const sp = await getJson(targets.searchHeadFqdn, '/services/search/distributed/peers', creds);
      input.searchPeers = contents(sp.json);
    }
  }

  return input;
}

async function main() {
  const { evaluatePoll } = await import(pathToFileUrl(COMPILED)).catch(() =>
    die(`compiled evaluator not found at ${COMPILED}. Run \`npm run build\` (tsc) in rabbitmq/.`),
  );

  const targets = {
    clusterManagerFqdn: arg('cluster-manager-fqdn', '') || null,
    expectedIndexers: Number(arg('expected-indexers', '0')),
    captainCandidates: (arg('captain-candidates', '') || '').split(',').map((s) => s.trim()).filter(Boolean),
    expectedShcMembers: Number(arg('expected-shc-members', '0')),
    searchHeadFqdn: arg('search-head-fqdn', '') || null,
    indexerClusterEnabled: bool(arg('indexer-cluster-enabled'), false),
    shcEnabled: bool(arg('shc-enabled'), false),
  };
  const timeoutMs = Number(arg('timeout-ms', String(DEFAULT_TIMEOUT_MS)));
  const caPath = arg('ca', null);
  const insecure = !caPath; // pin with --ca, otherwise -k for the internal CA.

  const user = process.env.SPLUNK_ADMIN_USER || 'admin';
  const pass = process.env.SPLUNK_ADMIN_PASSWORD || '';
  if (!pass) die('SPLUNK_ADMIN_PASSWORD must be set in the environment (never passed on argv).');
  const creds = { user, pass, insecure, ca: caPath ? fs.readFileSync(caPath) : undefined };

  // Nothing cluster-shaped to gate on (e.g. standalone / HF-only): ansible
  // success is the readiness signal — exit green immediately.
  if (!targets.indexerClusterEnabled && !targets.shcEnabled) {
    console.log('[health-gate] no indexer cluster or SHC in topology — nothing to gate; ready.');
    console.log('RESULT {"ready":true,"gates":[]}');
    process.exit(0);
  }

  const deadline = Date.now() + timeoutMs;
  let backoff = BACKOFF_START_MS;
  let last = null;
  let attempt = 0;

  console.log(
    `[health-gate] polling (idxCluster=${targets.indexerClusterEnabled} shc=${targets.shcEnabled} ` +
      `expectedIndexers=${targets.expectedIndexers} expectedShcMembers=${targets.expectedShcMembers} ` +
      `timeout=${Math.round(timeoutMs / 1000)}s tls=${insecure ? 'insecure(-k)' : 'pinned'})`,
  );

  while (Date.now() < deadline) {
    attempt += 1;
    const input = await gatherPoll(targets, creds);
    last = evaluatePoll(input);
    const summary = last.gates.map((g) => `${g.name}:${g.ready ? 'OK' : 'wait'}(${g.detail})`).join(' | ');
    console.log(`[health-gate] attempt ${attempt}: ${last.ready ? 'GREEN' : 'not ready'} — ${summary}`);
    if (last.ready) {
      console.log(`RESULT ${JSON.stringify({ ready: true, gates: last.gates })}`);
      process.exit(0);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(backoff, remaining));
    backoff = Math.min(Math.round(backoff * BACKOFF_FACTOR), BACKOFF_MAX_MS);
  }

  const failedGate = last?.failedGate ?? 'unknown';
  const detail = last?.gates.find((g) => g.name === failedGate)?.detail ?? 'no successful poll';
  console.error(
    `[health-gate] TIMEOUT after ${Math.round(timeoutMs / 1000)}s — gate "${failedGate}" never went green (${detail}).`,
  );
  console.log(`RESULT ${JSON.stringify({ ready: false, failedGate, gates: last?.gates ?? [] })}`);
  process.exit(2);
}

main().catch((e) => die(e instanceof Error ? e.stack ?? e.message : String(e)));
