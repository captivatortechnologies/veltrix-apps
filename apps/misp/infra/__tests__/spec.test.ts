// Proves the SAME generic SDK renders another, very different tool (MISP). Runs in
// the standard suite via `node scripts/test-apps.mjs misp`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateInfraSpec, renderInfraVars } from '@veltrixsecops/app-sdk/opentofu';
import { spec } from '../spec.js';

test('the MISP spec is valid', () => {
  assert.deepEqual(validateInfraSpec(spec), []);
});

test('renders MISP-shaped tfvars — HTTPS front door on 443 to misp-core', () => {
  const v = renderInfraVars(spec);
  assert.ok(v.load_balancer, 'expected a load balancer');
  assert.equal(v.load_balancer.target_port, 443);
  assert.equal(v.load_balancer.target_protocol, 'HTTPS');
  assert.equal(v.load_balancer.health_check_path, '/users/login');
  assert.deepEqual(v.load_balancer.target_kinds, ['misp-core', 'standalone']);
});

test('renders MISP stack ports as peer/self rules (MariaDB 3306, Redis 6379)', () => {
  const v = renderInfraVars(spec);
  const byPort = Object.fromEntries(v.security_rules.map((r) => [r.port, r]));
  assert.deepEqual(byPort[3306].sources, ['self']);
  assert.deepEqual(byPort[6379].sources, ['self']);
  // The only ALB-facing port is the MISP web tier.
  const albPorts = v.security_rules.filter((r) => r.sources.includes('alb')).map((r) => r.port);
  assert.deepEqual(albPorts, [443]);
});

test('MISP needs no object storage (storage omitted) yet still enables WAF', () => {
  const v = renderInfraVars(spec);
  assert.equal(v.waf_enabled, true);
  assert.equal(v.alb_auth.enabled, false);
  // No explicit compute allow-list — MISP roles are compute via foundation-exclusion.
  assert.deepEqual(v.compute_kinds, []);
});
