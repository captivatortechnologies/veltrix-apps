#!/usr/bin/env node
// =============================================================================
// build-inventory.mjs — thin CLI over the PURE inventory derivation.
//
// Single source of truth for the derivation lives in TypeScript
// (src/services/splunk/inventory.ts). This CLI imports the COMPILED output
// (dist/services/splunk/inventory.js) so there is exactly one implementation;
// the TS unit tests exercise the same code. Run `npm run build` (tsc) first.
//
// Inputs:
//   --plan <path>          plan JSON: an array of plan items OR a tfvars object
//                          with a `.plan` array. Accepts planKey or plan_key.
//   --tofu-output <path>   `tofu output -json` result (root outputs):
//                          instance_private_ips (REQUIRED), node_fqdns
//                          (optional -> derived), resource_refs (secrets ARN).
//   --out <path>           where to write the Ansible inventory YAML.
//   --health-out <path>    where to write the health-targets sidecar JSON
//                          (consumed by health-gate.mjs / bringUp.ts).
//   --secrets-arn <arn>    Secrets Manager ARN; falls back to
//                          resource_refs["foundation/secrets"].
//   --region <r>           AWS region for the aws_secret lookups.
//   --dns-domain <d>       DNS domain for FQDN fallback when node_fqdns absent.
//
// Exit non-zero (loudly) on any structural error — CI must fail, not proceed.
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// splunk/inventory/ -> rabbitmq/ -> dist/services/splunk/inventory.js
const COMPILED = path.resolve(__dirname, '../../dist/services/splunk/inventory.js');

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function die(msg) {
  console.error(`[build-inventory] ERROR: ${msg}`);
  process.exit(1);
}

async function loadLogic() {
  if (!fs.existsSync(COMPILED)) {
    die(
      `compiled logic not found at ${COMPILED}. Run \`npm run build\` (tsc) in rabbitmq/ ` +
        `before invoking build-inventory.mjs so it can import the single-source derivation.`,
    );
  }
  return import(pathToFileUrl(COMPILED));
}

function pathToFileUrl(p) {
  // Windows-safe file: URL for dynamic import.
  const resolved = path.resolve(p).replace(/\\/g, '/');
  return resolved.startsWith('/') ? `file://${resolved}` : `file:///${resolved}`;
}

function readJson(p, label) {
  if (!p) die(`--${label} is required`);
  if (!fs.existsSync(p)) die(`${label} file not found: ${p}`);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    die(`${label} is not valid JSON (${p}): ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** resource_refs may be a bare map or a { value } tofu output. */
function refsValue(tofu) {
  const refs = tofu?.resource_refs;
  if (!refs) return {};
  return refs.value ?? refs ?? {};
}

async function main() {
  const planPath = arg('plan');
  const tofuPath = arg('tofu-output');
  const outPath = arg('out');
  const healthOut = arg('health-out');
  const region = arg('region', process.env.AWS_REGION ?? null);
  const dnsDomain = arg('dns-domain', process.env.SPLUNK_DNS_DOMAIN ?? null);
  let secretsArn = arg('secrets-arn', process.env.SPLUNK_SECRETS_ARN ?? null);

  if (!outPath) die('--out is required');

  const rawPlan = readJson(planPath, 'plan');
  const tofu = readJson(tofuPath, 'tofu-output');
  if (!secretsArn) {
    const refs = refsValue(tofu);
    secretsArn = refs['foundation/secrets'] ?? null;
  }

  const { buildInventoryModel, toInventoryYaml } = await loadLogic();

  let model;
  try {
    model = buildInventoryModel(rawPlan, tofu, { secretsArn, region, dnsDomain });
  } catch (e) {
    die(e instanceof Error ? e.message : String(e));
  }

  for (const w of model.warnings) console.error(`[build-inventory] WARN: ${w}`);

  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, toInventoryYaml(model));

  if (healthOut) {
    fs.mkdirSync(path.dirname(path.resolve(healthOut)), { recursive: true });
    fs.writeFileSync(healthOut, JSON.stringify({ ...model.health, warnings: model.warnings }, null, 2) + '\n');
  }

  const g = model.groups;
  const summary = Object.keys(g)
    .filter((k) => g[k].length > 0)
    .map((k) => `${k}=${g[k].length}`)
    .join(' ');
  console.error(
    `[build-inventory] wrote ${outPath} (${model.hosts.length} hosts: ${summary}); ` +
      `shc_enabled=${model.vars.shcEnabled} idx_cluster=${model.vars.indexerClusterEnabled}`,
  );
}

main().catch((e) => die(e instanceof Error ? e.stack ?? e.message : String(e)));
