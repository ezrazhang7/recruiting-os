import type { HttpClient, SourceItem, SourceType } from '../types';
import { assertPublicHttpUrl, classifyUrl } from '../url';
import { extractUrls, nowIso, stableId } from '../lib/util';

function decodeEntities(s:string):string { return s.replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>'); }
function stripTags(html:string):string { return decodeEntities(html.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim()); }
function linksFromHtml(html:string,base:string):string[] {
  const out:string[]=[]; for(const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)){ try{ out.push(new URL(decodeEntities(m[1]),base).toString()); }catch{} }
  return [...new Set(out)];
}
function titleFromHtml(html:string):string|undefined { const m=html.match(/<title[^>]*>([\s\S]*?)<\/title>/i); return m?stripTags(m[1]):undefined; }

export class WebConnector {
  constructor(private http:HttpClient=fetch, private validate:(u:string)=>Promise<URL>=assertPublicHttpUrl){}
  async fetchSource(orgId:string,url:string,sourceType?:SourceType):Promise<{source:SourceItem;links:string[]}> {
    await this.validate(url);
    const ctrl=new AbortController(); const timer=setTimeout(()=>ctrl.abort(),12000);
    try{
      const r=await this.http(url,{redirect:'follow',signal:ctrl.signal,headers:{'user-agent':'RecruitingOS/0.1 (+campus recruiting aggregator)'}});
      if(!r.ok) throw new Error(`Fetch failed ${r.status}: ${url}`);
      const ct=r.headers.get('content-type')??''; const finalUrl=r.url||url;
      if(!ct.includes('text/html')&&!ct.includes('text/plain')) throw new Error(`Unsupported content-type ${ct}`);
      const body=await r.text(); const links=ct.includes('html')?linksFromHtml(body,finalUrl):extractUrls(body);
      const kind=classifyUrl(finalUrl); const st=sourceType??(kind==='application'?'application':kind==='bio_link'?'bio_link':'website');
      const text=ct.includes('html')?stripTags(body):body;
      const source:SourceItem={id:stableId('src',`${st}:${finalUrl}:${text.slice(0,500)}`),organizationId:orgId,sourceType:st,externalId:`${st}:${finalUrl}`,url:finalUrl,title:ct.includes('html')?titleFromHtml(body):undefined,rawText:text,media:[],fetchedAt:nowIso(),metadata:{contentType:ct}};
      return {source,links};
    } finally { clearTimeout(timer); }
  }
}
