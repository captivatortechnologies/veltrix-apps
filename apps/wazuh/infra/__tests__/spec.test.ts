// Proves the SAME generic SDK renders another, very different tool. Runs in the
// standard suite via `node scripts/test-apps.mjs wazuh`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateInfraSpec, renderInfraVars } from '@veltrixsecops/app-sdk/opentofu';
import { spec } from '../spec.js';

test('the Wazuh spec is valid', () => {
  assert.deepEqual(validateInfraSpec(spec), []);
});

test('renders a Wazuh-shaped front door — HTTPS on 443 to the dashboard', () => {
  const v = renderInfraVars(spec);
  assert.ok(v.load_balancer, 'expected a load balancer');
  assert.equal(v.load_balancer.target_port, 443);
  assert.equal(v.load_balancer.target_protocol, 'HTTPS');
  assert.equal(v.load_balancer.health_check_path, '/app/login');
  assert.deepEqual(v.load_balancer.target_kinds, ['dashboard']);
});

test('renders Wazuh cluster ports (API 55000 ALB-facing, cluster 1516 + indexer 9300 peer-only)', () => {
  const v = renderInfraVars(spec);
  const byPort = Object.fromEntries(v.security_rules.map((r) => [r.port, r]));
  assert.deepEqual(byPort[1516].sources, ['self']);
  assert.deepEqual(byPort[9300].sources, ['self']);
  assert.ok(byPort[55000].sources.includes('alb'));
  assert.ok(byPort[9200].sources.includes('admin'));
  // The ALB-facing ports are the dashboard and the manager API.
  const albPorts = v.security_rules.filter((r) => r.sources.includes('alb')).map((r) => r.port).sort((a, b) => a - b);
  assert.deepEqual(albPorts, [443, 55000]);
});

test('Wazuh needs no object storage (storage omitted) yet still enables WAF', () => {
  const v = renderInfraVars(spec);
  assert.equal(v.waf_enabled, true);
  assert.equal(v.alb_auth.enabled, false);
  // No explicit compute allow-list — Wazuh roles are compute via foundation-exclusion.
  assert.deepEqual(v.compute_kinds, []);
});
