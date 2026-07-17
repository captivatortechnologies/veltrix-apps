// =============================================================================
// bringUpEnvironment — the typed orchestrator for the Splunk bring-up layer.
//
// Three stages, each a discrete child process so this mirrors EXACTLY what the
// byol-apply CI workflow runs (one code path, not two):
//   1. inventory : node splunk/inventory/build-inventory.mjs  -> inventory.yml
//                  (+ a health-targets sidecar the health stage consumes)
//   2. ansible   : ansible-playbook -i inventory.yml splunk/ansible/site.yml
//                  (ordered plays enforce the bring-up sequence)
//   3. health    : node splunk/health/health-gate.mjs         -> polls Splunk
//                  REST until every applicable gate is green (or hard timeout)
//
// Secrets: admin creds flow to the health stage via ENV (SPLUNK_ADMIN_USER /
// SPLUNK_ADMIN_PASSWORD, populated by CI from Secrets Manager) — NEVER argv,
// NEVER logged. The pass4SymmKey / splunk.secret material is consumed by ansible
// via an aws_secret lookup keyed on the secrets ARN carried in the inventory.
// =============================================================================

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BringUpInput, BringUpResult, HealthTargets } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Self-contained progress logging — the generic platform worker invokes this as
// the app's `bringup` entrypoint, so it must not depend on any worker internals.
const logger = {
  info: (m: string) => process.stdout.write(`${m}\n`),
  warn: (m: string) => process.stderr.write(`${m}\n`),
};

// Bring-up artifacts live alongside this orchestrator in the app's infra bundle:
//   infra/bringup/{orchestrator,inventory,health,ansible}
// so they resolve one level up from orchestrator/, wherever the app is unpacked.
function defaultPaths() {
  const bringupRoot = path.resolve(__dirname, '..');
  return {
    buildInventoryScript: path.join(bringupRoot, 'inventory', 'build-inventory.mjs'),
    healthGateScript: path.join(bringupRoot, 'health', 'health-gate.mjs'),
    ansibleDir: path.join(bringupRoot, 'ansible'),
  };
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn a child, stream its output live to the parent (so CI logs show progress)
 * while buffering it for the caller. `env` overrides are merged over process.env
 * — used to pass secrets that must never appear in argv.
 */
function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      const s = d.toString();
      stdout += s;
      process.stdout.write(s);
    });
    child.stderr.on('data', (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      process.stderr.write(s);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/**
 * Build the inventory + health-targets sidecar, run the ordered ansible play,
 * then gate on Splunk's own health. Returns a typed result; never throws for a
 * "not ready" outcome (that is data), only for a genuine orchestration error.
 */
export async function bringUpEnvironment(input: BringUpInput): Promise<BringUpResult> {
  const d = defaultPaths();
  const buildInventoryScript = input.buildInventoryScript ?? d.buildInventoryScript;
  const healthGateScript = input.healthGateScript ?? d.healthGateScript;
  const ansibleDir = input.ansibleDir ?? d.ansibleDir;
  const inventoryPath = input.inventoryOutPath;
  const healthTargetsPath = `${inventoryPath}.health.json`;
  const warnings: string[] = [];

  const base: Pick<BringUpResult, 'adminActivationRequired' | 'inventoryPath' | 'warnings'> = {
    adminActivationRequired: true,
    inventoryPath,
    warnings,
  };

  // --- Stage 1: inventory ------------------------------------------------
  logger.info(`[splunk/bringUp] stage=inventory building ${inventoryPath}`);
  const invArgs = [
    buildInventoryScript,
    '--plan', input.planPath,
    '--tofu-output', input.tofuOutputPath,
    '--out', inventoryPath,
    '--health-out', healthTargetsPath,
  ];
  if (input.secretsArn) invArgs.push('--secrets-arn', input.secretsArn);
  if (input.region) invArgs.push('--region', input.region);
  if (input.dnsDomain) invArgs.push('--dns-domain', input.dnsDomain);
  const inv = await run(process.execPath, invArgs);
  if (inv.code !== 0) {
    return { ...base, ready: false, phase: 'inventory' };
  }

  const targets = JSON.parse(await fs.readFile(healthTargetsPath, 'utf8')) as HealthTargets & {
    warnings?: string[];
  };
  if (Array.isArray(targets.warnings)) warnings.push(...targets.warnings);

  // --- Stage 2: ansible (ordered plays enforce the bring-up sequence) ----
  if (!input.skipAnsible) {
    logger.info('[splunk/bringUp] stage=ansible running ordered site play');
    const play = await run('ansible-playbook', [
      '-i', inventoryPath,
      path.join(ansibleDir, 'site.yml'),
    ]);
    if (play.code !== 0) {
      return { ...base, ready: false, phase: 'ansible' };
    }
  } else {
    logger.warn('[splunk/bringUp] skipAnsible=true — inventory + health only');
  }

  // --- Stage 3: health gate ---------------------------------------------
  logger.info('[splunk/bringUp] stage=health polling Splunk REST until green');
  const healthArgs = [
    healthGateScript,
    '--cluster-manager-fqdn', targets.clusterManagerFqdn ?? '',
    '--expected-indexers', String(targets.expectedIndexerCount),
    '--captain-candidates', targets.shcCaptainCandidates.join(','),
    '--expected-shc-members', String(targets.expectedShcMemberCount),
    '--search-head-fqdn', targets.searchHeadFqdn ?? '',
    '--indexer-cluster-enabled', String(targets.indexerClusterEnabled),
    '--shc-enabled', String(targets.shcEnabled),
  ];
  if (input.healthTimeoutMs) healthArgs.push('--timeout-ms', String(input.healthTimeoutMs));
  // Admin creds ride the ENV only (never argv). CI populates these from Secrets
  // Manager just before this call; process.env already carries them.
  const health = await run(process.execPath, healthArgs);
  if (health.code === 0) {
    return { ...base, ready: true, phase: 'done' };
  }
  return { ...base, ready: false, phase: 'health', failedGate: parseFailedGate(health.stdout) };
}

/** health-gate.mjs prints a final `RESULT {json}` line; recover the failed gate. */
function parseFailedGate(stdout: string): string | undefined {
  const lines = stdout.trim().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^RESULT\s+(\{.*\})\s*$/);
    if (m) {
      try {
        const parsed = JSON.parse(m[1]) as { failedGate?: string };
        return parsed.failedGate;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
