import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store';
import { IngestionService } from '../src/ingest';
import { fallbackExtractor } from '../src/extractor';
import type { SourceItem } from '../src/types';
import { resolveOrganization } from '../src/resolver';

test('180DC stale Spring website + closed form is not presented as current',async()=>{
  const st=new Store();await st.upsertOrganization({id:'180dc-unc',name:'180 Degrees Consulting at UNC',school:'UNC',websiteUrl:'https://unc180dc.wixsite.com/home/join-us',instagramHandle:'unc180dc'});const ing=new IngestionService(st,fallbackExtractor);
  const website:SourceItem={id:'website',organizationId:'180dc-unc',sourceType:'website',url:'https://unc180dc.wixsite.com/home/join-us',rawText:'Spring 2026 Applications. Information Session January 12 at 6 PM. Applications are due January 16, 2026 at 11:59 PM. Apply https://docs.google.com/forms/d/e/old/viewform',media:[],publishedAt:'2026-01-05T12:00:00Z',fetchedAt:'2026-08-27T12:00:00Z'};
  const form:SourceItem={id:'form',organizationId:'180dc-unc',sourceType:'application',url:'https://docs.google.com/forms/d/e/old/viewform',rawText:'The form 180 Degrees Consulting Spring 2026 Application is no longer accepting responses.',media:[],publishedAt:'2026-01-17T12:00:00Z',fetchedAt:'2026-08-27T12:00:00Z'};
  await ing.ingest(website,{followLinks:false});await ing.ingest(form,{followLinks:false});const app=(await resolveOrganization(st,'180dc-unc',new Date('2026-08-27T12:00:00Z'))).find(o=>o.kind==='application');
  assert.equal(app?.deadlineAt,'2026-01-16T23:59:00-05:00');assert.equal(app?.stale,true);assert.match(app?.explanation??'',/closed|past/i);await st.close();
});

test('180DC newer social open announcement suppresses stale Spring deadline',async()=>{
  const st=new Store();await st.upsertOrganization({id:'180dc-unc',name:'180 Degrees Consulting at UNC',school:'UNC'});const ing=new IngestionService(st,fallbackExtractor);
  await ing.ingest({id:'old',organizationId:'180dc-unc',sourceType:'website',rawText:'Applications are due January 16, 2026 at 11:59 PM',media:[],publishedAt:'2026-01-05T12:00:00Z',fetchedAt:'2026-08-27T12:00:00Z'},{followLinks:false});
  await ing.ingest({id:'new',organizationId:'180dc-unc',sourceType:'instagram',rawText:'Fall recruiting is here — applications are now OPEN! Link in bio.',media:[],publishedAt:'2026-08-27T12:00:00Z',fetchedAt:'2026-08-27T12:00:00Z'},{followLinks:false});
  const app=(await resolveOrganization(st,'180dc-unc',new Date('2026-08-27T12:00:00Z'))).find(o=>o.kind==='application');assert.equal(app?.deadlineAt,undefined);assert.equal(app?.stale,false);assert.match(app?.explanation??'',/suppressed/i);await st.close();
});
