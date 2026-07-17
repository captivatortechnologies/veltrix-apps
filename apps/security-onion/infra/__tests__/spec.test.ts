// Proves the SAME generic SDK renders a second, very different tool. Runs in the
// standard suite via `node scripts/test-apps.mjs security-onion`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateInfraSpec, renderInfraVars } from '@veltrixsecops/app-sdk/opentofu';
import { spec } from '../spec.js';

test('the Security Onion spec is valid', () => {
  assert.deepEqual(validateInfraSpec(spec), []);
});

test('renders SO-shaped tfvars — HTTPS front door on 443 (unlike Splunk HTTP:8000)', () => {
  const v = renderInfraVars(spec);
  assert.ok(v.load_balancer, 'expected a load balancer');
  assert.equal(v.load_balancer.target_port, 443);
  assert.equal(v.load_balancer.target_protocol, 'HTTPS');
  assert.equal(v.load_balancer.health_check_path, '/login');
  assert.deepEqual(v.load_balancer.target_kinds, ['manager', 'manager-search', 'standalone']);
});

test('renders SO grid ports as peer/self rules (Salt 4505/4506, ES transport 9300)', () => {
  const v = renderInfraVars(spec);
  const byPort = Object.fromEntries(v.security_rules.map((r) => [r.port, r]));
  assert.deepEqual(byPort[4505].sources, ['self']);
  assert.deepEqual(byPort[4506].sources, ['self']);
  assert.deepEqual(byPort[9300].sources, ['self']);
  assert.deepEqual(byPort[9200].sources, ['self', 'admin']);
  // The only ALB-facing port is the SOC console.
  const albPorts = v.security_rules.filter((r) => r.sources.includes('alb')).map((r) => r.port);
  assert.deepEqual(albPorts, [443]);
});

test('SO needs no object storage (storage omitted) yet still enables WAF', () => {
  const v = renderInfraVars(spec);
  assert.equal(v.waf_enabled, true);
  assert.equal(v.alb_auth.enabled, false);
  // No explicit compute allow-list — SO roles are compute via foundation-exclusion.
  assert.deepEqual(v.compute_kinds, []);
});
