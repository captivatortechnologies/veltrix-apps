// Proves the SAME generic SDK renders another, very different tool (Greenbone /
// OpenVAS). Runs in the standard suite via `node scripts/test-apps.mjs greenbone`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateInfraSpec, renderInfraVars } from '@veltrixsecops/app-sdk/opentofu';
import { spec } from '../spec.js';

test('the Greenbone spec is valid', () => {
  assert.deepEqual(validateInfraSpec(spec), []);
});

test('renders Greenbone-shaped tfvars — HTTPS front door on 443 to the manager tier', () => {
  const v = renderInfraVars(spec);
  assert.ok(v.load_balancer, 'expected a load balancer');
  assert.equal(v.load_balancer.target_port, 443);
  assert.equal(v.load_balancer.target_protocol, 'HTTPS');
  assert.equal(v.load_balancer.health_check_path, '/');
  assert.deepEqual(v.load_balancer.target_kinds, ['greenbone', 'standalone']);
});

test('renders Greenbone data-service ports as peer/self rules (PostgreSQL 5432, Redis 6379)', () => {
  const v = renderInfraVars(spec);
  const byPort = Object.fromEntries(v.security_rules.map((r) => [r.port, r]));
  assert.deepEqual(byPort[5432].sources, ['self']);
  assert.deepEqual(byPort[6379].sources, ['self']);
  // The only ALB-facing port is the GSA web UI.
  const albPorts = v.security_rules.filter((r) => r.sources.includes('alb')).map((r) => r.port);
  assert.deepEqual(albPorts, [443]);
});

test('Greenbone needs no object storage and enables WAF', () => {
  const v = renderInfraVars(spec);
  assert.equal(v.waf_enabled, true);
  assert.equal(v.alb_auth.enabled, false);
  // Compute is inferred by foundation-exclusion (no explicit allow-list).
  assert.deepEqual(v.compute_kinds, []);
});
