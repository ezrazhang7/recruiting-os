import type { HttpClient, SourceItem } from '../types';
import type { Store } from '../store';
import { nowIso, stableId } from '../lib/util';

const API='https://api.groupme.com/v3';
export function groupMeOAuthUrl(clientId:string,redirectUri?:string):string {
  const u=new URL('https://oauth.groupme.com/oauth/authorize'); u.searchParams.set('client_id',clientId); if(redirectUri)u.searchParams.set('redirect_uri',redirectUri); return u.toString();
}
export class GroupMeConnector {
  constructor(private token:string,private http:HttpClient=fetch){}
  private async get(path:string):Promise<any>{ const r=await this.http(`${API}${path}${path.includes('?')?'&':'?'}token=${encodeURIComponent(this.token)}`); if(!r.ok)throw new Error(`GroupMe ${r.status}`); return (await r.json()).response; }
  async groups():Promise<any[]>{ return this.get('/groups?per_page=100'); }
  async messages(groupId:string,afterId?:string):Promise<any[]>{ const q=new URLSearchParams({limit:'100'}); if(afterId)q.set('after_id',afterId); const r=await this.get(`/groups/${encodeURIComponent(groupId)}/messages?${q}`); return r.messages??[]; }
  async syncGroup(store:Store,orgId:string,groupId:string):Promise<SourceItem[]>{
    const state=store.getConnectorState('groupme',groupId); const msgs=await this.messages(groupId,state.cursor); const out:SourceItem[]=[];
    const sorted=msgs.slice().sort((a,b)=>Number(a.created_at)-Number(b.created_at));
    for(const m of sorted){
      const media=(m.attachments??[]).flatMap((a:any)=>a.type==='image'&&a.url?[{type:'image' as const,url:a.url}]:[]);
      out.push({id:stableId('src',`groupme:${groupId}:${m.id}`),organizationId:orgId,sourceType:'groupme',externalId:`${groupId}:${m.id}`,url:`https://groupme.com/chats/${groupId}`,title:m.name?`GroupMe — ${m.name}`:'GroupMe message',rawText:m.text??'',media,publishedAt:new Date(Number(m.created_at)*1000).toISOString(),fetchedAt:nowIso(),metadata:{groupId,messageId:m.id,senderId:m.user_id}});
    }
    if(sorted.length) store.setConnectorState('groupme',groupId,String(sorted.at(-1).id));
    return out;
  }
}
