import type { HttpClient, SourceItem, MediaRef } from '../types';
import { nowIso, normalizeHandle, stableId } from '../lib/util';

export class InstagramConnector {
  constructor(private token:string,private igUserId:string,private apiVersion='v24.0',private http:HttpClient=fetch){}
  private async get(url:string):Promise<any>{ const r=await this.http(url); if(!r.ok)throw new Error(`Instagram ${r.status}: ${await r.text()}`); return r.json(); }
  async businessDiscovery(handle:string,limit=25):Promise<{profile:any;sources:SourceItem[]}> {
    const h=normalizeHandle(handle);
    const fields=`business_discovery.username(${h}){id,username,name,biography,website,profile_picture_url,media.limit(${limit}){id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,children{media_type,media_url,thumbnail_url}}}`;
    const u=new URL(`https://graph.facebook.com/${this.apiVersion}/${this.igUserId}`); u.searchParams.set('fields',fields); u.searchParams.set('access_token',this.token);
    const data=await this.get(u.toString()); const p=data.business_discovery; if(!p)throw new Error(`No business_discovery result for @${h}`);
    const sources:SourceItem[]=(p.media?.data??[]).map((m:any)=>{
      const media:MediaRef[]=[]; const add=(x:any)=>{ const url=x.media_type==='VIDEO'?(x.thumbnail_url||x.media_url):x.media_url; if(url)media.push({type:'image',url}); };
      add(m); for(const c of m.children?.data??[])add(c);
      return {id:stableId('src',`instagram:${m.id}`),organizationId:'',sourceType:'instagram' as const,externalId:m.id,url:m.permalink,title:`Instagram @${h}`,rawText:m.caption??'',media,publishedAt:m.timestamp,fetchedAt:nowIso(),metadata:{handle:h,mediaType:m.media_type}};
    });
    return {profile:p,sources};
  }
  async sourcesForOrganization(orgId:string,handle:string,limit=25){ const x=await this.businessDiscovery(handle,limit); return {profile:x.profile,sources:x.sources.map(s=>({...s,organizationId:orgId}))}; }
}
