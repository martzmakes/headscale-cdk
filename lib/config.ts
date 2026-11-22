import { Node } from 'constructs';

/** Typed, validated view of the CDK context (cdk.json "context" or `-c key=value`). */
export interface HeadscaleConfig {
  /** Route 53 public hosted zone, e.g. martzmakes.com */
  readonly hostedZoneName: string;
  /** FQDN for the control plane, e.g. hs.martzmakes.com (must be inside hostedZoneName) */
  readonly recordName: string;
  /** Emails allowed to register nodes via OIDC (Headscale oidc.allowed_users) */
  readonly allowedUsers: string[];
  /** Cognito hosted domain prefix (<prefix>.auth.<region>.amazoncognito.com) */
  readonly cognitoDomainPrefix: string;
  /** Lightsail bundle, default micro_3_0 (1 GB, $7/mo incl. IPv4) */
  readonly bundleId: string;
  /** Lightsail blueprint, default ubuntu_24_04 */
  readonly blueprintId: string;
  /** Lightsail instance name */
  readonly instanceName: string;
  /** AZ; defaults to <region>a */
  readonly availabilityZone?: string;
  /** CIDRs allowed to reach TCP 22. Empty = no direct SSH. */
  readonly sshCidrs: string[];
  /** Also allow the Lightsail browser-SSH ranges ("lightsail-connect" alias) */
  readonly allowLightsailConnect: boolean;
  /** MagicDNS base domain; must differ from (and not be a parent of) recordName */
  readonly magicDnsBaseDomain: string;
  /** Global nameservers pushed to clients (e.g. Pi-hole tailnet IP later) */
  readonly nameservers: string[];
  /** Daily auto-snapshot time, UTC, HH:00 */
  readonly snapshotTimeOfDay: string;
  /** Cognito MFA: "required" forces TOTP enrollment at next sign-in; "optional" never prompts */
  readonly mfa: 'required' | 'optional';
  /** Headplane: disable the API-key login form (OIDC only) */
  readonly disableApiKeyLogin: boolean;
  /** Optional: email for a Route 53 health check alarm on https://<recordName>/health (~$0.60/mo) */
  readonly alertEmail?: string;
  /** Fingerprint of the deployed instance's user data; synth fails if it would change */
  readonly pinnedUserDataFingerprint?: string;
  /** Explicit opt-in to replace the instance when user data changed */
  readonly replaceInstance: boolean;
}

function raw(node: Node, key: string): unknown {
  return node.tryGetContext(key);
}

function str(node: Node, key: string, def?: string): string {
  const v = raw(node, key);
  if (v === undefined || v === null || v === '') {
    if (def !== undefined) return def;
    throw new Error(`Missing required context "${key}" (set in cdk.json or pass -c ${key}=...)`);
  }
  if (typeof v !== 'string') throw new Error(`Context "${key}" must be a string`);
  return v.trim();
}

/** Accepts a JSON array, a comma-separated string (from -c), or a single string. */
function list(node: Node, key: string, def?: string[]): string[] {
  const v = raw(node, key);
  if (v === undefined || v === null || v === '') {
    if (def !== undefined) return def;
    throw new Error(`Missing required context "${key}"`);
  }
  let arr: unknown = v;
  if (typeof v === 'string') {
    const s = v.trim();
    arr = s.startsWith('[') ? JSON.parse(s) : s.split(',').map((x) => x.trim()).filter(Boolean);
  }
  if (!Array.isArray(arr) || !arr.every((x) => typeof x === 'string')) {
    throw new Error(`Context "${key}" must be a list of strings`);
  }
  return arr as string[];
}

function bool(node: Node, key: string, def: boolean): boolean {
  const v = raw(node, key);
  if (v === undefined || v === null || v === '') return def;
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new Error(`Context "${key}" must be true/false`);
}

const FQDN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const IPV4_CIDR = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
const IP = /^((\d{1,3}\.){3}\d{1,3}|[0-9a-f:]+)$/i;

export function loadConfig(node: Node): HeadscaleConfig {
  const hostedZoneName = str(node, 'hostedZoneName').replace(/\.$/, '').toLowerCase();
  const recordName = str(node, 'recordName').replace(/\.$/, '').toLowerCase();
  const magicDnsBaseDomain = str(node, 'magicDnsBaseDomain', 'tailnet.internal').toLowerCase();

  if (!FQDN.test(hostedZoneName)) throw new Error(`hostedZoneName "${hostedZoneName}" is not a valid domain`);
  if (!FQDN.test(recordName)) throw new Error(`recordName "${recordName}" must be a FQDN, e.g. hs.${hostedZoneName}`);
  if (recordName !== hostedZoneName && !recordName.endsWith(`.${hostedZoneName}`)) {
    throw new Error(`recordName "${recordName}" is not inside hosted zone "${hostedZoneName}"`);
  }
  // Headscale refuses a base_domain equal to, or a parent of, the server_url host.
  if (recordName === magicDnsBaseDomain || recordName.endsWith(`.${magicDnsBaseDomain}`)) {
    throw new Error(`magicDnsBaseDomain "${magicDnsBaseDomain}" must not equal or contain recordName "${recordName}"`);
  }

  const allowedUsers = list(node, 'allowedUsers');
  if (allowedUsers.length === 0) throw new Error('allowedUsers must contain at least one email');
  for (const u of allowedUsers) if (!/^[^@\s]+@[^@\s]+$/.test(u)) throw new Error(`allowedUsers entry "${u}" is not an email`);

  const sshCidrs = list(node, 'sshCidrs', []);
  for (const c of sshCidrs) if (!IPV4_CIDR.test(c)) throw new Error(`sshCidrs entry "${c}" is not an IPv4 CIDR`);

  const nameservers = list(node, 'nameservers', ['1.1.1.1', '1.0.0.1']);
  for (const n of nameservers) if (!IP.test(n)) throw new Error(`nameservers entry "${n}" is not an IP address`);

  const snapshotTimeOfDay = str(node, 'snapshotTimeOfDay', '07:00');
  if (!/^([01]\d|2[0-3]):00$/.test(snapshotTimeOfDay)) throw new Error('snapshotTimeOfDay must be HH:00 (UTC)');

  const cognitoDomainPrefix = str(node, 'cognitoDomainPrefix', recordName.replace(/\./g, '-'));
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(cognitoDomainPrefix) || /aws|amazon|cognito/.test(cognitoDomainPrefix)) {
    throw new Error(`cognitoDomainPrefix "${cognitoDomainPrefix}" is invalid (lowercase, digits, hyphens; may not contain aws/amazon/cognito)`);
  }

  return {
    hostedZoneName,
    recordName,
    allowedUsers,
    cognitoDomainPrefix,
    bundleId: str(node, 'bundleId', 'micro_3_0'),
    blueprintId: str(node, 'blueprintId', 'ubuntu_24_04'),
    instanceName: str(node, 'instanceName', 'headscale'),
    availabilityZone: raw(node, 'availabilityZone') ? str(node, 'availabilityZone') : undefined,
    sshCidrs,
    allowLightsailConnect: bool(node, 'allowLightsailConnect', true),
    magicDnsBaseDomain,
    nameservers,
    snapshotTimeOfDay,
    disableApiKeyLogin: bool(node, 'disableApiKeyLogin', true),
    mfa: ((): 'required' | 'optional' => {
      const m = str(node, 'mfa', 'required');
      if (m !== 'required' && m !== 'optional') throw new Error('mfa must be "required" or "optional"');
      return m;
    })(),
    alertEmail: ((): string | undefined => {
      const e = raw(node, 'alertEmail') ? str(node, 'alertEmail') : undefined;
      if (e && !/^[^@\s]+@[^@\s]+$/.test(e)) throw new Error(`alertEmail "${e}" is not an email`);
      return e;
    })(),
    pinnedUserDataFingerprint: raw(node, 'pinnedUserDataFingerprint') ? str(node, 'pinnedUserDataFingerprint') : undefined,
    replaceInstance: bool(node, 'replaceInstance', false),
  };
}
