import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type UrlKind =
  | 'application'
  | 'bio_link'
  | 'groupme'
  | 'instagram'
  | 'linkedin'
  | 'heel_life'
  | 'website'
  | 'unknown';
export interface PublicHttpTarget {
  url: URL;
  addresses: Array<{ address: string; family: 4 | 6 }>;
}

export function classifyUrl(raw: string): UrlKind {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'unknown';
  }
  const host = url.hostname.toLowerCase();
  const full = `${host}${url.pathname}`.toLowerCase();
  if (
    host === 'forms.gle' ||
    host === 'docs.google.com' ||
    host.endsWith('.qualtrics.com') ||
    full.includes('apply')
  )
    return 'application';
  if (
    ['linktr.ee', 'beacons.ai', 'carrd.co', 'bio.site'].some(
      (domain) => host === domain || host.endsWith(`.${domain}`),
    )
  )
    return 'bio_link';
  if (host === 'groupme.com' || host.endsWith('.groupme.com')) return 'groupme';
  if (host === 'instagram.com' || host.endsWith('.instagram.com')) return 'instagram';
  if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) return 'linkedin';
  if (host === 'heellife.unc.edu') return 'heel_life';
  return url.protocol === 'http:' || url.protocol === 'https:' ? 'website' : 'unknown';
}

function ipv4Number(address: string): number | undefined {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return undefined;
  return (
    (((parts[0] ?? 0) << 24) >>> 0) +
    ((parts[1] ?? 0) << 16) +
    ((parts[2] ?? 0) << 8) +
    (parts[3] ?? 0)
  );
}
function inIpv4Cidr(address: string, network: string, prefix: number): boolean {
  const value = ipv4Number(address);
  const base = ipv4Number(network);
  if (value === undefined || base === undefined) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
}
export function isPublicIp(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0] ?? address.toLowerCase();
  if (isIP(normalized) === 4) {
    const blocked: Array<[string, number]> = [
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.0.2.0', 24],
      ['192.168.0.0', 16],
      ['198.18.0.0', 15],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4],
    ];
    return !blocked.some(([network, prefix]) => inIpv4Cidr(normalized, network, prefix));
  }
  if (isIP(normalized) !== 6) return false;
  if (
    normalized === '::' ||
    normalized === '::1' ||
    /^(fc|fd)/.test(normalized) ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith('ff') ||
    normalized.startsWith('2001:db8')
  )
    return false;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return isPublicIp(mapped);
  const mappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex?.[1] && mappedHex[2]) {
    const high = parseInt(mappedHex[1], 16);
    const low = parseInt(mappedHex[2], 16);
    return isPublicIp(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  return true;
}

export async function resolvePublicHttpTarget(raw: string): Promise<PublicHttpTarget> {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('Only http(s) URLs are allowed');
  if (url.username || url.password) throw new Error('Credentialed URLs are not allowed');
  const allowedPort =
    url.port === '' ||
    (url.protocol === 'http:' && url.port === '80') ||
    (url.protocol === 'https:' && url.port === '443');
  if (!allowedPort) throw new Error('Non-standard ports are not allowed');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local'))
    throw new Error('Local hosts are not allowed');
  const family = isIP(host);
  const records = family
    ? [{ address: host, family: family as 4 | 6 }]
    : (await lookup(host, { all: true, verbatim: true })).map((record) => ({
        address: record.address,
        family: record.family as 4 | 6,
      }));
  if (records.length === 0 || records.some((record) => !isPublicIp(record.address)))
    throw new Error('Host resolves to a non-public IP');
  return { url, addresses: records };
}
export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  return (await resolvePublicHttpTarget(raw)).url;
}
