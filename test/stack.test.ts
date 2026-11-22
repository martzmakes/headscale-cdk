import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { loadConfig } from '../lib/config';
import { HeadscaleStack } from '../lib/headscale-stack';

const ENV = { account: '111111111111', region: 'us-east-1' };
const BASE_CTX: Record<string, unknown> = {
  hostedZoneName: 'example.com',
  recordName: 'hs.example.com',
  allowedUsers: ['me@example.com'],
  cognitoDomainPrefix: 'example-hs',
  sshCidrs: ['203.0.113.10/32'],
  nameservers: ['1.1.1.1'],
  // Mock the Route 53 lookup so tests never call AWS.
  'hosted-zone:account=111111111111:domainName=example.com:region=us-east-1': {
    Id: '/hostedzone/Z0000000000TEST',
    Name: 'example.com.',
  },
};

function synth(extra: Record<string, unknown> = {}) {
  const app = new App({ context: { ...BASE_CTX, ...extra } });
  const stack = new HeadscaleStack(app, 'Test', { config: loadConfig(app.node), env: ENV });
  return { stack, template: Template.fromStack(stack) };
}

/** Flatten an Fn::Join user data into one string with tokens shown as markers. */
function userDataOf(template: Template): string {
  const inst = Object.values(template.findResources('AWS::Lightsail::Instance'))[0] as any;
  const ud = inst.Properties.UserData;
  if (typeof ud === 'string') return ud;
  return (ud['Fn::Join'][1] as unknown[]).map((p) => (typeof p === 'string' ? p : '<TOKEN>')).join('');
}

describe('HeadscaleStack', () => {
  const { template } = synth();
  const userData = userDataOf(template);

  test('Lightsail instance: bundle, blueprint, auto-snapshot, firewall', () => {
    template.hasResourceProperties('AWS::Lightsail::Instance', {
      BundleId: 'micro_3_0',
      BlueprintId: 'ubuntu_24_04',
      AvailabilityZone: 'us-east-1a',
      AddOns: [{ AddOnType: 'AutoSnapshot', Status: 'Enabled', AutoSnapshotAddOnRequest: { SnapshotTimeOfDay: '07:00' } }],
      Networking: {
        Ports: Match.arrayWith([
          Match.objectLike({ FromPort: 80, Protocol: 'tcp', Cidrs: ['0.0.0.0/0'] }),
          Match.objectLike({ FromPort: 443, Protocol: 'tcp', Cidrs: ['0.0.0.0/0'] }),
          Match.objectLike({ FromPort: 3478, Protocol: 'udp', Cidrs: ['0.0.0.0/0'] }),
          Match.objectLike({ FromPort: 22, Cidrs: ['203.0.113.10/32'], CidrListAliases: ['lightsail-connect'] }),
        ]),
      },
    });
  });

  test('SSH closed when no CIDRs and no Lightsail connect', () => {
    const t = synth({ sshCidrs: [], allowLightsailConnect: false }).template;
    const inst = Object.values(t.findResources('AWS::Lightsail::Instance'))[0] as any;
    expect(inst.Properties.Networking.Ports.map((p: any) => p.FromPort)).toEqual([80, 443, 3478]);
  });

  test('static IP attached and A record points at it', () => {
    template.hasResourceProperties('AWS::Lightsail::StaticIp', { AttachedTo: { Ref: Match.anyValue() } });
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'hs.example.com.',
      Type: 'A',
      HostedZoneId: 'Z0000000000TEST',
      ResourceRecords: [{ 'Fn::GetAtt': [Match.stringLikeRegexp('StaticIp'), 'IpAddress'] }],
    });
  });

  test('Cognito pool: no self sign-up, email sign-in, required TOTP, retained', () => {
    template.hasResource('AWS::Cognito::UserPool', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: Match.objectLike({
        AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
        UsernameAttributes: ['email'],
        MfaConfiguration: 'ON',
        EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
      }),
    });
    template.hasResourceProperties('AWS::Cognito::UserPoolDomain', { Domain: 'example-hs', ManagedLoginVersion: 2 });
  });

  test('one confidential client with both callbacks', () => {
    template.resourceCountIs('AWS::Cognito::UserPoolClient', 1);
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: true,
      AllowedOAuthFlows: ['code'],
      AllowedOAuthScopes: Match.arrayWith(['openid', 'email', 'profile']),
      CallbackURLs: ['https://hs.example.com/oidc/callback', 'https://hs.example.com/admin/oidc/callback'],
    });
  });

  test('user data carries no secrets and has the expected config', () => {
    expect(userData).not.toMatch(/ClientSecret|client_secret:\s*"[^"]/);
    expect(userData).toContain('client_secret_path: "/run/secrets/oidc_client_secret"');
    expect(userData).toContain('server_url: https://hs.example.com');
    expect(userData).toContain('mode: database');
    expect(userData).toContain('base_domain: tailnet.internal');
    expect(userData).toContain('- "me@example.com"');
    expect(userData).toContain('image: headscale/headscale:0.29.7');
    expect(userData).toContain('image: ghcr.io/tale/headplane:0.8.2');
    expect(userData).toContain('api_key_path: "/run/secrets/headscale_api_key"');
    expect(userData).not.toMatch(/\{\{[A-Z_]+\}\}/); // every placeholder rendered
    // Headplane 0.8.2 rejects a disabled kubernetes block without pod_name.
    expect(userData).not.toMatch(/^\s+kubernetes:/m);
  });

  test('replacement guard blocks a changed user-data fingerprint', () => {
    expect(() => synth({ pinnedUserDataFingerprint: 'deadbeefdeadbeef' })).toThrow(/REPLACE the Lightsail instance/);
    expect(() => synth({ pinnedUserDataFingerprint: 'deadbeefdeadbeef', replaceInstance: 'true' })).not.toThrow();
  });

  test('fingerprint is stable across synths', () => {
    const fp = (t: Template) => t.findOutputs('UserDataFingerprint').UserDataFingerprint.Value;
    expect(fp(synth().template)).toEqual(fp(template));
  });

  test('health alarm is opt-in', () => {
    expect(template.findResources('AWS::Route53::HealthCheck')).toEqual({});
    const t = synth({ alertEmail: 'me@example.com' }).template;
    t.hasResourceProperties('AWS::Route53::HealthCheck', {
      HealthCheckConfig: Match.objectLike({ Type: 'HTTPS', FullyQualifiedDomainName: 'hs.example.com', ResourcePath: '/health' }),
    });
    t.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'me@example.com' });
    t.hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName: 'HealthCheckStatus', Threshold: 1, TreatMissingData: 'breaching' });
  });

  test('config validation', () => {
    expect(() => synth({ recordName: 'hs.other.com' })).toThrow(/not inside hosted zone/);
    expect(() => synth({ magicDnsBaseDomain: 'example.com' })).toThrow(/must not equal or contain/);
    expect(() => synth({ cognitoDomainPrefix: 'my-aws-login' })).toThrow(/cognitoDomainPrefix/);
  });
});

describe('user data shell', () => {
  test('outer script is POSIX sh (Lightsail runs it with dash) and re-execs bash', () => {
    const app = new App({ context: BASE_CTX });
    const t = Template.fromStack(new HeadscaleStack(app, 'T2', { config: loadConfig(app.node), env: ENV }));
    const ud = userDataOf(t);
    const outer = ud.split("<<'__HS_FIRSTBOOT__'")[0] + ud.split('\n__HS_FIRSTBOOT__\n')[1];
    expect(ud.startsWith('#!/bin/sh')).toBe(true);
    expect(outer).not.toMatch(/pipefail|\[\[/);
    expect(outer).toContain('bash /var/lib/hs-firstboot.sh');
  });
});
