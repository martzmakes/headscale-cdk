import { createHash } from 'crypto';
import { Annotations, CfnOutput, Duration, RemovalPolicy, Stack, StackProps, Tags, Token } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lightsail from 'aws-cdk-lib/aws-lightsail';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubs from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import { HeadscaleConfig } from './config';
import { readTemplate, render, writeFileSnippet, yamlList } from './render';
import { IMAGES } from './versions';

export interface HeadscaleStackProps extends StackProps {
  readonly config: HeadscaleConfig;
}

export class HeadscaleStack extends Stack {
  constructor(scope: Construct, id: string, props: HeadscaleStackProps) {
    super(scope, id, props);
    const cfg = props.config;
    const domain = cfg.recordName;
    Tags.of(this).add('project', 'headscale');

    // ---------------------------------------------------------------- Cognito
    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'headscale',
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      // REQUIRED makes managed login walk users through TOTP setup (QR code) at sign-in;
      // with OPTIONAL the hosted UI never offers enrollment.
      mfa: cfg.mfa === 'required' ? cognito.Mfa.REQUIRED : cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      passwordPolicy: { minLength: 12, requireSymbols: false },
      // Essentials is required for the new managed login UI; free under 10k MAU.
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const userPoolDomain = userPool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: cfg.cognitoDomainPrefix },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });

    // One confidential client shared by Headscale and Headplane so `sub` matches.
    const client = userPool.addClient('Client', {
      userPoolClientName: 'headscale-headplane',
      generateSecret: true,
      authFlows: { userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [`https://${domain}/oidc/callback`, `https://${domain}/admin/oidc/callback`],
        logoutUrls: [`https://${domain}/admin/login?s=logout`],
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      preventUserExistenceErrors: true,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
    });

    // Managed login v2 renders an error page unless a branding style exists for the client.
    new cognito.CfnManagedLoginBranding(this, 'LoginBranding', {
      userPoolId: userPool.userPoolId,
      clientId: client.userPoolClientId,
      useCognitoProvidedValues: true,
    });

    const issuer = userPool.userPoolProviderUrl; // https://cognito-idp.<region>.amazonaws.com/<poolId>

    // ---------------------------------------------------------- Rendered files
    const vars: Record<string, string> = {
      DOMAIN: domain,
      HEADSCALE_IMAGE: IMAGES.headscale,
      HEADPLANE_IMAGE: IMAGES.headplane,
      CADDY_IMAGE: IMAGES.caddy,
      HEADSCALE_VERSION: `v${IMAGES.headscale.split(':')[1]}`,
      HEADPLANE_VERSION: `v${IMAGES.headplane.split(':')[1]}`,
      OIDC_ISSUER: issuer,
      OIDC_CLIENT_ID: client.userPoolClientId,
      MAGIC_DNS_BASE_DOMAIN: cfg.magicDnsBaseDomain,
      NAMESERVERS_YAML: yamlList(cfg.nameservers, 6),
      ALLOWED_USERS_YAML: yamlList(cfg.allowedUsers, 4),
      DISABLE_API_KEY_LOGIN: String(cfg.disableApiKeyLogin),
    };

    const files: Array<[string, string, string]> = [
      ['/opt/headscale/docker-compose.yaml', 'docker-compose.yaml', '644'],
      ['/opt/headscale/Caddyfile', 'Caddyfile', '644'],
      ['/opt/headscale/config/config.yaml', 'headscale-config.yaml', '644'],
      ['/opt/headscale/headplane/config.yaml', 'headplane-config.yaml', '644'],
      ['/opt/headscale/bin/hs-bootstrap.sh', 'hs-bootstrap.sh', '755'],
      ['/opt/headscale/hs-bootstrap.service', 'hs-bootstrap.service', '644'],
      ['/opt/headscale/hs-bootstrap.path', 'hs-bootstrap.path', '644'],
    ];
    const buildUserData = (v: Record<string, string>) =>
      render(readTemplate('user-data.sh'), {
        WRITE_FILES: files.map(([dest, tpl, mode]) => writeFileSnippet(dest, render(readTemplate(tpl), v), mode)).join('\n'),
      });
    const userData = buildUserData(vars);

    // Replacement guard. Fingerprint the user data with deploy-time tokens masked
    // (they're stable for the life of the pool/client). Pin it in config after the
    // first deploy; a mismatch means "this deploy would replace the instance".
    const masked = Object.fromEntries(
      Object.entries(vars).map(([k, v]) => [k, Token.isUnresolved(v) ? `<${k}>` : v]),
    );
    const fingerprint = createHash('sha256').update(buildUserData(masked)).digest('hex').slice(0, 16);
    if (cfg.pinnedUserDataFingerprint && cfg.pinnedUserDataFingerprint !== fingerprint) {
      if (!cfg.replaceInstance) {
        throw new Error(
          `Instance user data changed (fingerprint ${cfg.pinnedUserDataFingerprint} -> ${fingerprint}). ` +
            'Deploying would REPLACE the Lightsail instance (new empty box). Upgrade in place with ' +
            'scripts/upgrade.sh instead, or pass -c replaceInstance=true after taking a snapshot.',
        );
      }
      Annotations.of(this).addWarning(`replaceInstance=true: instance will be replaced (fingerprint ${fingerprint})`);
    }

    // ---------------------------------------------------------------- Lightsail
    const open = (port: number, protocol: 'tcp' | 'udp'): lightsail.CfnInstance.PortProperty => ({
      fromPort: port,
      toPort: port,
      protocol,
      cidrs: ['0.0.0.0/0'],
    });
    const ports: lightsail.CfnInstance.PortProperty[] = [open(80, 'tcp'), open(443, 'tcp'), open(3478, 'udp')];
    if (cfg.sshCidrs.length > 0 || cfg.allowLightsailConnect) {
      ports.push({
        fromPort: 22,
        toPort: 22,
        protocol: 'tcp',
        ...(cfg.sshCidrs.length > 0 ? { cidrs: cfg.sshCidrs } : {}),
        ...(cfg.allowLightsailConnect ? { cidrListAliases: ['lightsail-connect'] } : {}),
      });
    }

    // NOTE: UserData is replace-on-update in CloudFormation. Editing any template
    // (or bumping an image) and redeploying REPLACES the instance -> new, empty box.
    // Day-2 changes go through scripts/sync.sh instead; see README "Upgrades".
    const instance = new lightsail.CfnInstance(this, 'Instance', {
      // Suffix with the user-data fingerprint: a user-data change forces replacement, and
      // CloudFormation creates the new instance before deleting the old one, so names must differ.
      instanceName: `${cfg.instanceName}-${fingerprint.slice(0, 8)}`,
      blueprintId: cfg.blueprintId,
      bundleId: cfg.bundleId,
      availabilityZone: cfg.availabilityZone ?? `${this.region}a`,
      userData,
      addOns: [
        {
          addOnType: 'AutoSnapshot',
          status: 'Enabled',
          autoSnapshotAddOnRequest: { snapshotTimeOfDay: cfg.snapshotTimeOfDay },
        },
      ],
      networking: { ports },
      tags: [{ key: 'project', value: 'headscale' }],
    });

    const staticIp = new lightsail.CfnStaticIp(this, 'StaticIp', {
      staticIpName: `${cfg.instanceName}-ip`, // stable across instance replacement
      attachedTo: instance.ref,
    });

    // ---------------------------------------------------------------- DNS
    const zone = route53.HostedZone.fromLookup(this, 'Zone', { domainName: cfg.hostedZoneName });
    new route53.ARecord(this, 'Record', {
      zone,
      recordName: domain,
      target: route53.RecordTarget.fromIpAddresses(staticIp.attrIpAddress),
      ttl: Duration.minutes(5),
    });

    // ---------------------------------------------------------------- Health alert (opt-in)
    // Existing tunnels keep working when the control plane is down, so an outage is silent:
    // new logins, key refreshes and DNS/route changes just stop. Route 53 probes /health from
    // several regions every 30 s; the alarm emails on failure and on recovery.
    if (cfg.alertEmail) {
      const healthCheck = new route53.CfnHealthCheck(this, 'HealthCheck', {
        healthCheckConfig: {
          type: 'HTTPS',
          fullyQualifiedDomainName: domain,
          resourcePath: '/health',
          port: 443,
          enableSni: true,
          requestInterval: 30,
          failureThreshold: 3,
        },
        healthCheckTags: [{ key: 'Name', value: `${domain} /health` }],
      });
      const topic = new sns.Topic(this, 'AlertTopic', { displayName: `${domain} health` });
      topic.addSubscription(new snsSubs.EmailSubscription(cfg.alertEmail));
      const alarm = new cloudwatch.Alarm(this, 'HealthAlarm', {
        alarmName: `${cfg.instanceName}-control-plane-down`,
        alarmDescription: `https://${domain}/health failing (Headscale control plane unreachable)`,
        // Route 53 health-check metrics are only published in us-east-1.
        metric: new cloudwatch.Metric({
          namespace: 'AWS/Route53',
          metricName: 'HealthCheckStatus',
          dimensionsMap: { HealthCheckId: healthCheck.attrHealthCheckId },
          statistic: 'Minimum',
          period: Duration.minutes(1),
          region: 'us-east-1',
        }),
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        threshold: 1,
        evaluationPeriods: 3,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      });
      alarm.addAlarmAction(new cwActions.SnsAction(topic));
      alarm.addOkAction(new cwActions.SnsAction(topic));
    }

    // ---------------------------------------------------------------- Outputs
    new CfnOutput(this, 'Url', { value: `https://${domain}` });
    new CfnOutput(this, 'UserDataFingerprint', {
      description: 'Pin as pinnedUserDataFingerprint in config.local.json to block accidental instance replacement',
      value: fingerprint,
    });
    new CfnOutput(this, 'AdminUrl', { value: `https://${domain}/admin` });
    new CfnOutput(this, 'InstanceName', { value: instance.ref });
    new CfnOutput(this, 'StaticIpAddress', { value: staticIp.attrIpAddress });
    new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: client.userPoolClientId });
    new CfnOutput(this, 'OidcIssuerUrl', { value: issuer });
    new CfnOutput(this, 'CognitoLoginDomain', { value: userPoolDomain.baseUrl() });
    new CfnOutput(this, 'CreateAdminUserCommand', {
      description: 'Creates your Cognito user (email_verified=true is required by Headscale allowed_users)',
      value: [
        'aws cognito-idp admin-create-user',
        `--region ${this.region}`,
        `--user-pool-id ${userPool.userPoolId}`,
        `--username ${cfg.allowedUsers[0]}`,
        `--user-attributes Name=email,Value=${cfg.allowedUsers[0]} Name=email_verified,Value=true`,
        '--desired-delivery-mediums EMAIL',
      ].join(' '),
    });
    new CfnOutput(this, 'BootstrapCommand', {
      description: 'Delivers the OIDC client secret to the box over SSH and starts Headscale/Headplane',
      value: `./scripts/bootstrap-secret.sh ${this.stackName}`,
    });
  }
}
