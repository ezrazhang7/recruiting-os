import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyUrl } from '../src/url';
import { extractUrls, stableId } from '../src/lib/util';
import { heuristicExtract, fallbackExtractor } from '../src/extractor';
import type { SourceItem } from '../src/types';
import { Store } from '../src/store';
import { IngestionService } from '../src/ingest';
import { resolveOrganization } from '../src/resolver';

const src=(text:string,over:Partial<SourceItem>={}):SourceItem=>({id:stableId('src',text+JSON.stringify(over)),organizationId:'org1',sourceType:'gmail',rawText:text,media:[],publishedAt:'2026-08-27T12:00:00Z',fetchedAt:'2026-08-27T12:01:00Z',...over});

test('URL classifier: GroupMe',()=>assert.equal(classifyUrl('https://groupme.com/join_group/123/abc'),'groupme'));
test('URL classifier: Google Form',()=>assert.equal(classifyUrl('https://docs.google.com/forms/d/e/x/viewform'),'application'));
test('URL classifier: Linktree',()=>assert.equal(classifyUrl('https://linktr.ee/unc180dc'),'bio_link'));
test('URL extractor strips sentence punctuation',()=>assert.deepEqual(extractUrls('Apply: https://forms.gle/abc.'),['https://forms.gle/abc']));

test('extract explicit application deadline',()=>{
  const r=heuristicExtract(src('Applications are due August 28 at 11:59 PM.'));
  assert.equal(r.claims.find(c=>c.field==='application_deadline')?.value,'2026-08-28T23:59:00-04:00');
});
test('does not confuse info session with deadline',()=>{
  const r=heuristicExtract(src('Info session: August 28 at 6 PM\nApplications are due September 3 at 11:59 PM'));
  assert.equal(r.claims.find(c=>c.field==='application_deadline')?.value,'2026-09-03T23:59:00-04:00');
  assert.equal((r.claims.find(c=>c.field==='event')?.value as any).startsAt,'2026-08-28T18:00:00-04:00');
});
test('extracts open state',()=>assert.equal(heuristicExtract(src('Applications are now open!')).claims.find(c=>c.field==='application_open')?.value,true));
test('extracts closed form state',()=>assert.equal(heuristicExtract(src('This form is no longer accepting responses.')).claims.find(c=>c.field==='application_open')?.value,false));
test('extracts application URL',()=>assert.equal(heuristicExtract(src('Apply here https://forms.gle/abc')).claims.find(c=>c.field==='application_url')?.value,'https://forms.gle/abc'));

test('resolver marks past deadline stale',async()=>{
  const st=new Store();st.upsertOrganization({id:'org1',name:'X',school:'UNC'});const ing=new IngestionService(st,fallbackExtractor);await ing.ingest(src('Applications are due August 20 at 11:59 PM'),{followLinks:false});
  const o=resolveOrganization(st,'org1',new Date('2026-08-27T12:00:00Z')).find(x=>x.kind==='application'); assert.equal(o?.stale,true);st.close();
});
test('newer open claim suppresses older deadline',async()=>{
  const st=new Store();st.upsertOrganization({id:'org1',name:'X',school:'UNC'});const ing=new IngestionService(st,fallbackExtractor);
  await ing.ingest(src('Applications due August 20 at 11:59 PM',{id:'old',publishedAt:'2026-08-10T12:00:00Z'}),{followLinks:false});
  await ing.ingest(src('Applications are now open!',{id:'new',sourceType:'instagram',publishedAt:'2026-08-27T12:00:00Z'}),{followLinks:false});
  const o=resolveOrganization(st,'org1',new Date('2026-08-27T12:00:00Z')).find(x=>x.kind==='application');assert.equal(o?.deadlineAt,undefined);assert.equal(o?.stale,false);st.close();
});
test('explicit closed claim wins',async()=>{
  const st=new Store();st.upsertOrganization({id:'org1',name:'X',school:'UNC'});const ing=new IngestionService(st,fallbackExtractor);
  await ing.ingest(src('Applications due September 30 at 11:59 PM',{id:'a',publishedAt:'2026-08-20T12:00:00Z'}),{followLinks:false});
  await ing.ingest(src('Applications are closed.',{id:'b',sourceType:'application',publishedAt:'2026-08-27T12:00:00Z'}),{followLinks:false});
  assert.equal(resolveOrganization(st,'org1',new Date('2026-08-27T12:00:00Z')).find(x=>x.kind==='application')?.stale,true);st.close();
});
