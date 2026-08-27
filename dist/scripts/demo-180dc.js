"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const store_1 = require("../src/store");
const ingest_1 = require("../src/ingest");
const extractor_1 = require("../src/extractor");
const resolver_1 = require("../src/resolver");
async function main() {
    const st = new store_1.Store();
    st.upsertOrganization({ id: '180dc-unc', name: '180 Degrees Consulting at UNC', school: 'UNC', websiteUrl: 'https://unc180dc.wixsite.com/home/join-us', instagramHandle: 'unc180dc', linkedinUrl: 'https://www.linkedin.com/company/180-degrees-consulting-unc/' });
    const ing = new ingest_1.IngestionService(st, extractor_1.fallbackExtractor);
    await ing.ingest({ id: 'web', organizationId: '180dc-unc', sourceType: 'website', url: 'https://unc180dc.wixsite.com/home/join-us', rawText: 'Spring 2026 Applications\nInfo Session January 12 at 6 PM\nApplications are due January 16, 2026 at 11:59 PM\nApply https://docs.google.com/forms/d/e/old/viewform', media: [], publishedAt: '2026-01-05T12:00:00Z', fetchedAt: new Date().toISOString() }, { followLinks: false });
    await ing.ingest({ id: 'form', organizationId: '180dc-unc', sourceType: 'application', url: 'https://docs.google.com/forms/d/e/old/viewform', rawText: 'This form is no longer accepting responses.', media: [], publishedAt: '2026-01-17T12:00:00Z', fetchedAt: new Date().toISOString() }, { followLinks: false });
    console.log(JSON.stringify({ organization: st.getOrganization('180dc-unc'), opportunities: (0, resolver_1.resolveOrganization)(st, '180dc-unc', new Date('2026-08-27T12:00:00Z')), claims: st.listClaims('180dc-unc') }, null, 2));
    st.close();
}
main().catch(e => { console.error(e); process.exit(1); });
