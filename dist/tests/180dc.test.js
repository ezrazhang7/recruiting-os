"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const store_1 = require("../src/store");
const ingest_1 = require("../src/ingest");
const extractor_1 = require("../src/extractor");
const resolver_1 = require("../src/resolver");
(0, node_test_1.default)('180DC stale Spring website + closed form is not presented as current', async () => {
    const st = new store_1.Store();
    st.upsertOrganization({ id: '180dc-unc', name: '180 Degrees Consulting at UNC', school: 'UNC', websiteUrl: 'https://unc180dc.wixsite.com/home/join-us', instagramHandle: 'unc180dc' });
    const ing = new ingest_1.IngestionService(st, extractor_1.fallbackExtractor);
    const website = { id: 'website', organizationId: '180dc-unc', sourceType: 'website', url: 'https://unc180dc.wixsite.com/home/join-us', rawText: 'Spring 2026 Applications. Information Session January 12 at 6 PM. Applications are due January 16, 2026 at 11:59 PM. Apply https://docs.google.com/forms/d/e/old/viewform', media: [], publishedAt: '2026-01-05T12:00:00Z', fetchedAt: '2026-08-27T12:00:00Z' };
    const form = { id: 'form', organizationId: '180dc-unc', sourceType: 'application', url: 'https://docs.google.com/forms/d/e/old/viewform', rawText: 'The form 180 Degrees Consulting Spring 2026 Application is no longer accepting responses.', media: [], publishedAt: '2026-01-17T12:00:00Z', fetchedAt: '2026-08-27T12:00:00Z' };
    await ing.ingest(website, { followLinks: false });
    await ing.ingest(form, { followLinks: false });
    const app = (0, resolver_1.resolveOrganization)(st, '180dc-unc', new Date('2026-08-27T12:00:00Z')).find(o => o.kind === 'application');
    strict_1.default.equal(app?.deadlineAt, '2026-01-16T23:59:00-04:00');
    strict_1.default.equal(app?.stale, true);
    strict_1.default.match(app?.explanation ?? '', /closed|past/i);
    st.close();
});
(0, node_test_1.default)('180DC newer social open announcement suppresses stale Spring deadline', async () => {
    const st = new store_1.Store();
    st.upsertOrganization({ id: '180dc-unc', name: '180 Degrees Consulting at UNC', school: 'UNC' });
    const ing = new ingest_1.IngestionService(st, extractor_1.fallbackExtractor);
    await ing.ingest({ id: 'old', organizationId: '180dc-unc', sourceType: 'website', rawText: 'Applications are due January 16, 2026 at 11:59 PM', media: [], publishedAt: '2026-01-05T12:00:00Z', fetchedAt: '2026-08-27T12:00:00Z' }, { followLinks: false });
    await ing.ingest({ id: 'new', organizationId: '180dc-unc', sourceType: 'instagram', rawText: 'Fall recruiting is here — applications are now OPEN! Link in bio.', media: [], publishedAt: '2026-08-27T12:00:00Z', fetchedAt: '2026-08-27T12:00:00Z' }, { followLinks: false });
    const app = (0, resolver_1.resolveOrganization)(st, '180dc-unc', new Date('2026-08-27T12:00:00Z')).find(o => o.kind === 'application');
    strict_1.default.equal(app?.deadlineAt, undefined);
    strict_1.default.equal(app?.stale, false);
    strict_1.default.match(app?.explanation ?? '', /suppressed/i);
    st.close();
});
