import { Store } from '../src/store';
import { IngestionService } from '../src/ingest';
import { fallbackExtractor } from '../src/extractor';
import { resolveOrganization } from '../src/resolver';

async function main(){
  const st=new Store();st.upsertOrganization({id:'180dc-unc',name:'180 Degrees Consulting at UNC',school:'UNC',websiteUrl:'https://unc180dc.wixsite.com/home/join-us',instagramHandle:'unc180dc',linkedinUrl:'https://www.linkedin.com/company/180-degrees-consulting-unc/'});const ing=new IngestionService(st,fallbackExtractor);
  await ing.ingest({id:'web',organizationId:'180dc-unc',sourceType:'website',url:'https://unc180dc.wixsite.com/home/join-us',rawText:'Spring 2026 Applications\nInfo Session January 12 at 6 PM\nApplications are due January 16, 2026 at 11:59 PM\nApply https://docs.google.com/forms/d/e/old/viewform',media:[],publishedAt:'2026-01-05T12:00:00Z',fetchedAt:new Date().toISOString()},{followLinks:false});
  await ing.ingest({id:'form',organizationId:'180dc-unc',sourceType:'application',url:'https://docs.google.com/forms/d/e/old/viewform',rawText:'This form is no longer accepting responses.',media:[],publishedAt:'2026-01-17T12:00:00Z',fetchedAt:new Date().toISOString()},{followLinks:false});
  console.log(JSON.stringify({organization:st.getOrganization('180dc-unc'),opportunities:resolveOrganization(st,'180dc-unc',new Date('2026-08-27T12:00:00Z')),claims:st.listClaims('180dc-unc')},null,2));st.close();
}
main().catch(e=>{console.error(e);process.exit(1)});
