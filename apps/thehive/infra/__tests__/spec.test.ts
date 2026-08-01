// Proves the SAME generic SDK renders another, very different tool (TheHive 5). Runs
// in the standard suite via `node scripts/test-apps.mjs thehive`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateInfraSpec, renderInfraVars } from '@veltrixsecops/app-sdk/opentofu';
import { spec } from '../spec.js';

test('the TheHive spec is valid', () => {
  assert.deepEqual(validateInfraSpec(spec), []);
});

test('renders TheHive-shaped tfvars — HTTP front door on 9000 to the application tier', () => {
  const v = renderInfraVars(spec);
  assert.ok(v.load_balancer, 'expected a load balancer');
  assert.equal(v.load_balancer.target_port, 9000);
  assert.equal(v.load_balancer.target_protocol, 'HTTP');
  assert.equal(v.load_balancer.health_check_path, '/api/v1/status');
  assert.deepEqual(v.load_balancer.target_kinds, ['thehive', 'standalone']);
});

test('renders TheHive data-service ports as peer/self rules (Cassandra 9042, ES transport 9300, MinIO 9100)', () => {
  const v = renderInfraVars(spec);
  const byPort = Object.fromEntries(v.security_rules.map((r) => [r.port, r]));
  assert.deepEqual(byPort[9042].sources, ['self']);
  assert.deepEqual(byPort[9300].sources, ['self']);
  assert.deepEqual(byPort[9100].sources, ['self']);
  // The only ALB-facing port is the TheHive web/API tier.
  const albPorts = v.security_rules.filter((r) => r.sources.includes('alb')).map((r) => r.port);
  assert.deepEqual(albPorts, [9000]);
});

test('TheHive declares an object-storage bucket and enables WAF', () => {
  const v = renderInfraVars(spec);
  assert.equal(v.waf_enabled, true);
  assert.equal(v.alb_auth.enabled, false);
  // Compute is inferred by foundation-exclusion (no explicit allow-list).
  assert.deepEqual(v.compute_kinds, []);
});
