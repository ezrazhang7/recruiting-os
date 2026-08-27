import type { Claim, Opportunity, SourceType } from './types';
import type { Store } from './store';
import { nowIso, stableId } from './lib/util';

const authority:Record<SourceType,number>={
  application:1.0, groupme:.96, instagram:.94, gmail:.92, linkedin:.88,
  website:.78, bio_link:.75, screenshot:.72, heel_life:.55
};

function scoreClaim(c:Claim, store:Store):number {
  const src=store.getSource(c.sourceItemId);
  const a=src?authority[src.sourceType]:.5;
  const t=new Date(c.publishedAt??c.extractedAt).getTime();
  const ageDays=Math.max(0,(Date.now()-t)/86400000);
  const recency=Math.max(.55,1-Math.min(ageDays,365)/800);
  return c.confidence*a*recency;
}
function newest<T extends Claim>(xs:T[]):T|undefined { return xs.slice().sort((a,b)=>new Date(b.publishedAt??b.extractedAt).getTime()-new Date(a.publishedAt??a.extractedAt).getTime())[0]; }

export function resolveOrganization(store:Store, orgId:string, now=new Date()):Opportunity[] {
  const claims=store.listClaims(orgId);
  const out:Opportunity[]=[];
  const deadlines=claims.filter(c=>c.field==='application_deadline');
  const appUrls=claims.filter(c=>c.field==='application_url');
  const openClaims=claims.filter(c=>c.field==='application_open');
  const events=claims.filter(c=>c.field==='event');
  const bestDeadline=deadlines.sort((a,b)=>scoreClaim(b,store)-scoreClaim(a,store))[0];
  const bestUrl=appUrls.sort((a,b)=>scoreClaim(b,store)-scoreClaim(a,store))[0];
  const latestOpen=newest(openClaims);

  if(bestDeadline || latestOpen){
    const deadlineAt=bestDeadline?String(bestDeadline.value):undefined;
    const deadlineTime=deadlineAt?new Date(deadlineAt).getTime():NaN;
    const latestOpenTime=latestOpen?new Date(latestOpen.publishedAt??latestOpen.extractedAt).getTime():0;
    const deadlineClaimTime=bestDeadline?new Date(bestDeadline.publishedAt??bestDeadline.extractedAt).getTime():0;
    const explicitlyClosed=latestOpen?.value===false && latestOpenTime>=deadlineClaimTime;
    const reopened=latestOpen?.value===true && latestOpenTime>deadlineClaimTime;
    const stale=explicitlyClosed || (!reopened && Number.isFinite(deadlineTime) && deadlineTime < now.getTime());
    out.push({
      id:stableId('opp',`${orgId}:application`),organizationId:orgId,kind:'application',title:'Application',
      deadlineAt:reopened?undefined:deadlineAt,url:bestUrl?String(bestUrl.value):undefined,
      confidence:Math.max(bestDeadline?scoreClaim(bestDeadline,store):0,latestOpen?scoreClaim(latestOpen,store):0),stale,
      sourceClaimIds:[bestDeadline?.id,bestUrl?.id,latestOpen?.id].filter(Boolean) as string[],
      explanation: reopened?'A newer source says applications are open; older deadline suppressed until a current deadline is confirmed.' : explicitlyClosed?'The newest authoritative source says applications are closed.' : stale?'The best-supported deadline is in the past.' : 'Resolved from the highest-confidence application claims.',
      resolvedAt:nowIso()
    });
  }

  for(const c of events){
    const v=c.value as any; if(!v||typeof v!=='object') continue;
    out.push({id:stableId('opp',`${orgId}:event:${v.title}:${v.startsAt??''}`),organizationId:orgId,kind:'event',title:String(v.title??'Recruiting event'),startsAt:v.startsAt,url:v.url,confidence:scoreClaim(c,store),stale:v.startsAt?new Date(v.startsAt).getTime()<now.getTime():false,sourceClaimIds:[c.id],explanation:'Event extracted from recruiting source.',resolvedAt:nowIso()});
  }
  store.replaceOpportunities(orgId,out);
  return out;
}
