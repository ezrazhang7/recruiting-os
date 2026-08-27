import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type UrlKind = 'application'|'bio_link'|'groupme'|'instagram'|'linkedin'|'heel_life'|'website'|'unknown';

export function classifyUrl(raw: string): UrlKind {
  let u: URL; try { u = new URL(raw); } catch { return 'unknown'; }
  const host=u.hostname.toLowerCase(); const full=(host+u.pathname).toLowerCase();
  if (host==='forms.gle'||host==='docs.google.com'||host.includes('qualtrics')||full.includes('apply')) return 'application';
  if (host.includes('linktr.ee')||host.includes('beacons.ai')||host.includes('carrd.co')||host.includes('bio.site')) return 'bio_link';
  if (host.includes('groupme.com')) return 'groupme';
  if (host.includes('instagram.com')) return 'instagram';
  if (host.includes('linkedin.com')) return 'linkedin';
  if (host.includes('heellife.unc.edu')) return 'heel_life';
  if (u.protocol==='http:'||u.protocol==='https:') return 'website';
  return 'unknown';
}

function privateIp(ip:string):boolean {
  if (ip==='::1'||ip==='0.0.0.0'||ip.startsWith('127.')||ip.startsWith('10.')||ip.startsWith('192.168.')||ip.startsWith('169.254.')) return true;
  const m=ip.match(/^172\.(\d+)\./); if(m && Number(m[1])>=16 && Number(m[1])<=31) return true;
  return ip.startsWith('fc')||ip.startsWith('fd')||ip.startsWith('fe80:');
}

export async function assertPublicHttpUrl(raw:string):Promise<URL> {
  const u=new URL(raw);
  if (!['http:','https:'].includes(u.protocol)) throw new Error('Only http(s) URLs are allowed');
  if (u.username||u.password) throw new Error('Credentialed URLs are not allowed');
  const h=u.hostname.toLowerCase();
  if (h==='localhost'||h.endsWith('.local')) throw new Error('Local hosts are not allowed');
  if (isIP(h) && privateIp(h)) throw new Error('Private IP not allowed');
  if (!isIP(h)) {
    const records=await lookup(h,{all:true});
    if(records.some(r=>privateIp(r.address))) throw new Error('Host resolves to private IP');
  }
  return u;
}
