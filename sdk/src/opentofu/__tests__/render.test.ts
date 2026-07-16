import { describe, it, expect } from 'vitest';
import { renderInfraVars } from '../render';
import { validateInfraSpec } from '../validate';
import type { InfraSpec } from '../spec';

/** A minimal, valid Splunk-shaped spec used across the render tests. */
const splunkish: InfraSpec = {
  securityRules: [
    { port: 8000, sources: ['alb'], description: 'Web' },
    { port: 9997, sources: ['self'] },
    { port: 8089, sources: ['self', 'admin'] },
  ],
  loadBalancer: {
    targetPort: 8000,
    healthCheckPath: '/en-US/account/login',
    targetKinds: ['search-head', 'standalone'],
  },
  dnsPrefixes: { indexer: 'idx', 'search-head': 'sh', 'cluster-manager': 'mgmt' },
  bringup: './bringup/ansible/site.yml',
};

describe('renderInfraVars', () => {
  it('applies protocol/description defaults to security rules', () => {
    const vars = renderInfraVars(splunkish);
    const s2s = vars.security_rules.find((r) => r.port === 9997)!;
    expect(s2s.protocol).toBe('tcp');
    expect(s2s.description).toBe('');
    expect(s2s.sources).toEqual(['self']);
  });

  it('renders the load balancer with matcher/protocol/listener defaults', () => {
    const vars = renderInfraVars(splunkish);
    expect(vars.load_balancer).not.toBeNull();
    expect(vars.load_balancer!.target_port).toBe(8000);
    expect(vars.load_balancer!.target_protocol).toBe('HTTP');
    expect(vars.load_balancer!.health_check_matcher).toBe('200-399');
    expect(vars.load_balancer!.health_check_protocol).toBe('');
    expect(vars.load_balancer!.listener_port).toBe(443);
    expect(vars.load_balancer!.target_kinds).toEqual(['search-head', 'standalone']);
  });

  it('defaults waf on when a load balancer is present', () => {
    expect(renderInfraVars(splunkish).waf_enabled).toBe(true);
  });

  it('defaults waf off for a headless (forwarder-only) spec', () => {
    const headless: InfraSpec = {
      securityRules: [{ port: 9997, sources: ['self'] }],
      dnsPrefixes: { 'heavy-forwarder': 'hf' },
    };
    const vars = renderInfraVars(headless);
    expect(vars.load_balancer).toBeNull();
    expect(vars.waf_enabled).toBe(false);
  });

  it('always emits a resolvable alb_auth (disabled by default)', () => {
    const vars = renderInfraVars(splunkish);
    expect(vars.alb_auth).toEqual({
      enabled: false,
      user_pool_arn: '',
      user_pool_client_id: '',
      user_pool_domain: '',
    });
  });

  it('passes through an explicit computeKinds allow-list', () => {
    const vars = renderInfraVars({ ...splunkish, computeKinds: ['indexer'] });
    expect(vars.compute_kinds).toEqual(['indexer']);
  });

  it('emits an empty compute_kinds when relying on foundation-exclusion', () => {
    expect(renderInfraVars(splunkish).compute_kinds).toEqual([]);
  });

  it('does not mutate the input spec', () => {
    const before = JSON.stringify(splunkish);
    renderInfraVars(splunkish);
    expect(JSON.stringify(splunkish)).toBe(before);
  });
});

describe('validateInfraSpec', () => {
  it('accepts a well-formed spec', () => {
    expect(validateInfraSpec(splunkish)).toEqual([]);
  });

  it('flags an alb source with no load balancer', () => {
    const bad: InfraSpec = {
      securityRules: [{ port: 8000, sources: ['alb'] }],
      dnsPrefixes: {},
    };
    const errs = validateInfraSpec(bad);
    expect(errs.some((e) => e.includes('source "alb"'))).toBe(true);
  });

  it('flags a load balancer whose target port is not opened to the alb', () => {
    const bad: InfraSpec = {
      securityRules: [{ port: 8000, sources: ['self'] }],
      loadBalancer: { targetPort: 8000, healthCheckPath: '/', targetKinds: ['search-head'] },
      dnsPrefixes: {},
    };
    const errs = validateInfraSpec(bad);
    expect(errs.some((e) => e.includes('not opened to source "alb"'))).toBe(true);
  });

  it('flags a non-absolute health check path', () => {
    const bad: InfraSpec = {
      securityRules: [{ port: 80, sources: ['alb'] }],
      loadBalancer: { targetPort: 80, healthCheckPath: 'health', targetKinds: ['web'] },
      dnsPrefixes: {},
    };
    expect(validateInfraSpec(bad).some((e) => e.includes('absolute path'))).toBe(true);
  });

  it('flags an unknown source', () => {
    const bad: InfraSpec = {
      // @ts-expect-error intentionally invalid source
      securityRules: [{ port: 22, sources: ['world'] }],
      dnsPrefixes: {},
    };
    expect(validateInfraSpec(bad).some((e) => e.includes('unknown source'))).toBe(true);
  });

  it('flags albAuth.enabled without a pool or a load balancer', () => {
    const bad: InfraSpec = {
      securityRules: [{ port: 8000, sources: ['alb'] }],
      loadBalancer: { targetPort: 8000, healthCheckPath: '/', targetKinds: ['web'] },
      dnsPrefixes: {},
      albAuth: { enabled: true },
    };
    expect(validateInfraSpec(bad).some((e) => e.includes('albAuth.enabled requires'))).toBe(true);
  });
});
