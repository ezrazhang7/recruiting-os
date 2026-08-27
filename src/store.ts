import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Claim, Organization, Opportunity, SourceItem } from './types';
import { parseJsonSafe } from './lib/util';

const schema = `
create table if not exists organizations (
  id text primary key, name text not null, school text not null,
  heel_life_url text, website_url text, instagram_handle text, linkedin_url text,
  created_at text not null default current_timestamp
);
create table if not exists source_items (
  id text primary key, organization_id text not null,
  source_type text not null, external_id text, url text, title text, raw_text text not null,
  media text not null default '[]', published_at text, fetched_at text not null, metadata text not null default '{}'
);
create unique index if not exists source_external_unique on source_items(source_type, external_id) where external_id is not null;
create table if not exists claims (
  id text primary key, organization_id text not null, source_item_id text not null,
  field text not null, value text not null, confidence real not null,
  published_at text, extracted_at text not null, supersedes text not null default '[]', evidence text
);
create index if not exists claims_org_field on claims(organization_id, field, published_at desc);
create table if not exists opportunities (
  id text primary key, organization_id text not null, kind text not null, title text not null,
  deadline_at text, starts_at text, url text, role text, confidence real not null,
  stale integer not null default 0, source_claim_ids text not null, explanation text not null, resolved_at text not null
);
create table if not exists connector_state (
  connector text not null, scope text not null, cursor text, metadata text not null default '{}',
  updated_at text not null default current_timestamp, primary key(connector, scope)
);`;

export class Store {
  readonly db: DatabaseSync;
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('pragma foreign_keys=on;');
    this.db.exec(schema);
  }

  close() { this.db.close(); }

  upsertOrganization(o: Organization) {
    this.db.prepare(`insert into organizations(id,name,school,heel_life_url,website_url,instagram_handle,linkedin_url)
      values(?,?,?,?,?,?,?) on conflict(id) do update set name=excluded.name, school=excluded.school,
      heel_life_url=coalesce(excluded.heel_life_url,organizations.heel_life_url),
      website_url=coalesce(excluded.website_url,organizations.website_url),
      instagram_handle=coalesce(excluded.instagram_handle,organizations.instagram_handle),
      linkedin_url=coalesce(excluded.linkedin_url,organizations.linkedin_url)`)
      .run(o.id,o.name,o.school,o.heelLifeUrl??null,o.websiteUrl??null,o.instagramHandle??null,o.linkedinUrl??null);
  }

  getOrganization(id: string): Organization | undefined {
    const r = this.db.prepare('select * from organizations where id=?').get(id) as any;
    if (!r) return undefined;
    return { id:r.id,name:r.name,school:r.school,heelLifeUrl:r.heel_life_url??undefined,websiteUrl:r.website_url??undefined,instagramHandle:r.instagram_handle??undefined,linkedinUrl:r.linkedin_url??undefined };
  }

  listOrganizations(): Organization[] {
    return (this.db.prepare('select * from organizations order by name').all() as any[]).map(r => ({
      id:r.id,name:r.name,school:r.school,heelLifeUrl:r.heel_life_url??undefined,websiteUrl:r.website_url??undefined,instagramHandle:r.instagram_handle??undefined,linkedinUrl:r.linkedin_url??undefined
    }));
  }

  putSource(s: SourceItem): boolean {
    try {
      this.db.prepare(`insert into source_items(id,organization_id,source_type,external_id,url,title,raw_text,media,published_at,fetched_at,metadata)
      values(?,?,?,?,?,?,?,?,?,?,?)`).run(s.id,s.organizationId,s.sourceType,s.externalId??null,s.url??null,s.title??null,s.rawText,JSON.stringify(s.media),s.publishedAt??null,s.fetchedAt,JSON.stringify(s.metadata??{}));
      return true;
    } catch (e) {
      if (String(e).includes('UNIQUE constraint failed')) return false;
      throw e;
    }
  }

  putClaims(claims: Claim[]) {
    const q = this.db.prepare(`insert or ignore into claims(id,organization_id,source_item_id,field,value,confidence,published_at,extracted_at,supersedes,evidence)
      values(?,?,?,?,?,?,?,?,?,?)`);
    for (const c of claims) q.run(c.id,c.organizationId,c.sourceItemId,c.field,JSON.stringify(c.value),c.confidence,c.publishedAt??null,c.extractedAt,JSON.stringify(c.supersedes??[]),c.evidence??null);
  }

  listClaims(orgId: string): Claim[] {
    return (this.db.prepare('select * from claims where organization_id=? order by coalesce(published_at,extracted_at)').all(orgId) as any[]).map(r => ({
      id:r.id,organizationId:r.organization_id,sourceItemId:r.source_item_id,field:r.field,value:parseJsonSafe(r.value,null),confidence:r.confidence,publishedAt:r.published_at??undefined,extractedAt:r.extracted_at,supersedes:parseJsonSafe(r.supersedes,[]),evidence:r.evidence??undefined
    }));
  }

  getSource(id: string): SourceItem | undefined {
    const r = this.db.prepare('select * from source_items where id=?').get(id) as any;
    if (!r) return undefined;
    return {id:r.id,organizationId:r.organization_id,sourceType:r.source_type,externalId:r.external_id??undefined,url:r.url??undefined,title:r.title??undefined,rawText:r.raw_text,media:parseJsonSafe(r.media,[]),publishedAt:r.published_at??undefined,fetchedAt:r.fetched_at,metadata:parseJsonSafe(r.metadata,{})};
  }

  replaceOpportunities(orgId: string, xs: Opportunity[]) {
    this.db.prepare('delete from opportunities where organization_id=?').run(orgId);
    const q = this.db.prepare(`insert into opportunities(id,organization_id,kind,title,deadline_at,starts_at,url,role,confidence,stale,source_claim_ids,explanation,resolved_at)
      values(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const x of xs) q.run(x.id,x.organizationId,x.kind,x.title,x.deadlineAt??null,x.startsAt??null,x.url??null,x.role??null,x.confidence,x.stale?1:0,JSON.stringify(x.sourceClaimIds),x.explanation,x.resolvedAt);
  }

  listOpportunities(orgId?: string): Opportunity[] {
    const rows = (orgId ? this.db.prepare('select * from opportunities where organization_id=? order by coalesce(deadline_at,starts_at)').all(orgId) : this.db.prepare('select * from opportunities order by coalesce(deadline_at,starts_at)').all()) as any[];
    return rows.map(r=>({id:r.id,organizationId:r.organization_id,kind:r.kind,title:r.title,deadlineAt:r.deadline_at??undefined,startsAt:r.starts_at??undefined,url:r.url??undefined,role:r.role??undefined,confidence:r.confidence,stale:!!r.stale,sourceClaimIds:parseJsonSafe(r.source_claim_ids,[]),explanation:r.explanation,resolvedAt:r.resolved_at}));
  }

  getConnectorState(connector:string, scope:string): {cursor?:string; metadata:Record<string,unknown>} {
    const r=this.db.prepare('select * from connector_state where connector=? and scope=?').get(connector,scope) as any;
    return r ? {cursor:r.cursor??undefined,metadata:parseJsonSafe(r.metadata,{})} : {metadata:{}};
  }

  setConnectorState(connector:string,scope:string,cursor?:string,metadata:Record<string,unknown>={}) {
    this.db.prepare(`insert into connector_state(connector,scope,cursor,metadata,updated_at) values(?,?,?,?,?)
    on conflict(connector,scope) do update set cursor=excluded.cursor,metadata=excluded.metadata,updated_at=excluded.updated_at`)
    .run(connector,scope,cursor??null,JSON.stringify(metadata),new Date().toISOString());
  }
}
