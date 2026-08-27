import type { HttpClient, SourceItem, MediaRef } from '../types';
import { nowIso, stableId } from '../lib/util';

export function linkedinVanityName(url:string):string|undefined { try{ const u=new URL(url); const m=u.pathname.match(/^\/company\/([^/]+)/); return m?.[1]; }catch{return undefined;} }
export class LinkedInConnector {
  constructor(private token:string,private version='202608',private http:HttpClient=fetch){}
  private headers(){ return {authorization:`Bearer ${this.token}`,'LinkedIn-Version':this.version,'X-Restli-Protocol-Version':'2.0.0'}; }
  private async get(url:string):Promise<any>{ const r=await this.http(url,{headers:this.headers()}); if(!r.ok)throw new Error(`LinkedIn ${r.status}: ${await r.text()}`); return r.json(); }
  async resolveOrganizationUrn(companyUrl:string):Promise<string>{
    const vanity=linkedinVanityName(companyUrl); if(!vanity)throw new Error('Invalid LinkedIn company URL');
    const u=`https://api.linkedin.com/rest/organizations?q=vanityName&vanityName=${encodeURIComponent(vanity)}`; const x=await this.get(u); const id=x.elements?.[0]?.id; if(!id)throw new Error(`No organization found for vanity ${vanity}`); return `urn:li:organization:${id}`;
  }
  async posts(orgId:string,organizationUrn:string,count=50):Promise<SourceItem[]>{
    const u=new URL('https://api.linkedin.com/rest/posts'); u.searchParams.set('q','author');u.searchParams.set('author',organizationUrn);u.searchParams.set('count',String(count));u.searchParams.set('sortBy','LAST_MODIFIED');
    const x=await this.get(u.toString()); const out:SourceItem[]=[];
    for(const p of x.elements??[]){
      const media:MediaRef[]=[]; const content=p.content??{};
      const imageUrns:string[]=[]; if(content.media?.id)imageUrns.push(content.media.id); for(const im of content.multiImage?.images??[])if(im.id)imageUrns.push(im.id);
      for(const urn of imageUrns){ try{ const img=await this.get(`https://api.linkedin.com/rest/images/${encodeURIComponent(urn)}`); const url=img.downloadUrl ?? (img.downloadUrlExpiresAt ? img.downloadUrl : undefined); if(url)media.push({type:'image',url}); }catch{} }
      out.push({id:stableId('src',`linkedin:${p.id}`),organizationId:orgId,sourceType:'linkedin',externalId:p.id,url:p.permalink??undefined,title:'LinkedIn organization post',rawText:p.commentary??'',media,publishedAt:p.publishedAt?new Date(Number(p.publishedAt)).toISOString():undefined,fetchedAt:nowIso(),metadata:{author:p.author,lifecycleState:p.lifecycleState}});
    }
    return out;
  }
}
