// Proves the SAME generic SDK renders another, very different tool. Runs in the
// standard suite via `node scripts/test-apps.mjs fleet`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateInfraSpec, renderInfraVars } from '@veltrixsecops/app-sdk/opentofu';
import { spec } from '../spec.js';

test('the Fleet spec is valid', () => {
  assert.deepEqual(validateInfraSpec(spec), []);
});

test('renders Fleet-shaped tfvars — HTTPS front door on 8080 (fleetdm default)', () => {
  const v = renderInfraVars(spec);
  assert.ok(v.load_balancer, 'expected a load balancer');
  assert.equal(v.load_balancer.target_port, 8080);
  assert.equal(v.load_balancer.target_protocol, 'HTTPS');
  assert.equal(v.load_balancer.health_check_path, '/healthz');
  assert.deepEqual(v.load_balancer.target_kinds, ['fleet-server', 'standalone']);
});

test('renders Fleet datastore ports as peer/self rules (MySQL 3306, Redis 6379)', () => {
  const v = renderInfraVars(spec);
  const byPort = Object.fromEntries(v.security_rules.map((r) => [r.port, r]));
  assert.deepEqual(byPort[3306].sources, ['self']);
  assert.deepEqual(byPort[6379].sources, ['self']);
  // The public front-door ports are the Fleet server HTTPS listeners only.
  const albPorts = v.security_rules.filter((r) => r.sources.includes('alb')).map((r) => r.port);
  assert.deepEqual(albPorts.sort((a, b) => a - b), [443, 8080]);
});

test('Fleet needs no object storage (storage omitted) yet still enables WAF', () => {
  const v = renderInfraVars(spec);
  assert.equal(v.waf_enabled, true);
  assert.equal(v.alb_auth.enabled, false);
  // No explicit compute allow-list — Fleet roles are compute via foundation-exclusion.
  assert.deepEqual(v.compute_kinds, []);
});
