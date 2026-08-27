import type { Claim, SourceItem } from './types';
import type { Store } from './store';
import type { Extractor } from './extractor';
import { classifyUrl } from './url';
import { nowIso, stableId } from './lib/util';
import { resolveOrganization } from './resolver';
import { WebConnector } from './connectors/web';

export class IngestionService {
  constructor(private store:Store, private extractor:Extractor, private web?:WebConnector){}

  async ingest(source:SourceItem,{followLinks=true,maxDepth=2}:{followLinks?:boolean;maxDepth?:number}={}):Promise<void>{
    const inserted=this.store.putSource(source);
    if(!inserted) return;
    const result=await this.extractor.extract(source);
    const claims:Claim[]=result.claims.map((c,i)=>({
      id:stableId('clm',`${source.id}:${i}:${c.field}:${JSON.stringify(c.value)}`),organizationId:source.organizationId,sourceItemId:source.id,field:c.field,value:c.value,confidence:c.confidence,publishedAt:source.publishedAt,extractedAt:nowIso(),evidence:c.evidence
    }));
    this.store.putClaims(claims);

    if(followLinks && this.web && maxDepth>0){
      const candidates=[...new Set(result.discoveredUrls)].filter(u=>['application','bio_link','website'].includes(classifyUrl(u)));
      for(const url of candidates.slice(0,12)){
        try{
          const {source:child,links}=await this.web.fetchSource(source.organizationId,url);
          await this.ingest(child,{followLinks:false});
          if(maxDepth>1 && classifyUrl(url)==='bio_link'){
            for(const next of links.filter(x=>['application','website'].includes(classifyUrl(x))).slice(0,10)){
              try{ const fetched=await this.web.fetchSource(source.organizationId,next); await this.ingest(fetched.source,{followLinks:false}); }catch{}
            }
          }
        }catch{}
      }
    }
    resolveOrganization(this.store,source.organizationId);
  }
}
