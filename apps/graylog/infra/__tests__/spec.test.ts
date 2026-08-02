// Proves the SAME generic SDK renders another, very different tool (Graylog). Runs
// in the standard suite via `node scripts/test-apps.mjs graylog`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateInfraSpec, renderInfraVars } from '@veltrixsecops/app-sdk/opentofu';
import { spec } from '../spec.js';

test('the Graylog spec is valid', () => {
  assert.deepEqual(validateInfraSpec(spec), []);
});

test('renders Graylog-shaped tfvars — HTTP front door on 9000 to the graylog tier', () => {
  const v = renderInfraVars(spec);
  assert.ok(v.load_balancer, 'expected a load balancer');
  assert.equal(v.load_balancer.target_port, 9000);
  assert.equal(v.load_balancer.target_protocol, 'HTTP');
  assert.equal(v.load_balancer.health_check_path, '/api/system/lbstatus');
  assert.deepEqual(v.load_balancer.target_kinds, ['graylog', 'standalone']);
});

test('renders Graylog data-service ports as peer/self rules (OpenSearch 9200/9300, MongoDB 27017)', () => {
  const v = renderInfraVars(spec);
  const byPort = Object.fromEntries(v.security_rules.map((r) => [r.port, r]));
  assert.deepEqual(byPort[9300].sources, ['self']);
  assert.deepEqual(byPort[27017].sources, ['self']);
  assert.deepEqual(byPort[9200].sources, ['self', 'admin']);
  // The only ALB-facing port is the Graylog web/REST tier.
  const albPorts = v.security_rules.filter((r) => r.sources.includes('alb')).map((r) => r.port);
  assert.deepEqual(albPorts, [9000]);
});

test('Graylog enables WAF and needs no object-storage bucket', () => {
  const v = renderInfraVars(spec);
  assert.equal(v.waf_enabled, true);
  assert.equal(v.alb_auth.enabled, false);
  // Compute is inferred by foundation-exclusion (no explicit allow-list).
  assert.deepEqual(v.compute_kinds, []);
});
