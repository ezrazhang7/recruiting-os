"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const url_1 = require("../src/url");
const util_1 = require("../src/lib/util");
const extractor_1 = require("../src/extractor");
const store_1 = require("../src/store");
const ingest_1 = require("../src/ingest");
const resolver_1 = require("../src/resolver");
const src = (text, over = {}) => ({ id: (0, util_1.stableId)('src', text + JSON.stringify(over)), organizationId: 'org1', sourceType: 'gmail', rawText: text, media: [], publishedAt: '2026-08-27T12:00:00Z', fetchedAt: '2026-08-27T12:01:00Z', ...over });
(0, node_test_1.default)('URL classifier: GroupMe', () => strict_1.default.equal((0, url_1.classifyUrl)('https://groupme.com/join_group/123/abc'), 'groupme'));
(0, node_test_1.default)('URL classifier: Google Form', () => strict_1.default.equal((0, url_1.classifyUrl)('https://docs.google.com/forms/d/e/x/viewform'), 'application'));
(0, node_test_1.default)('URL classifier: Linktree', () => strict_1.default.equal((0, url_1.classifyUrl)('https://linktr.ee/unc180dc'), 'bio_link'));
(0, node_test_1.default)('URL extractor strips sentence punctuation', () => strict_1.default.deepEqual((0, util_1.extractUrls)('Apply: https://forms.gle/abc.'), ['https://forms.gle/abc']));
(0, node_test_1.default)('extract explicit application deadline', () => {
    const r = (0, extractor_1.heuristicExtract)(src('Applications are due August 28 at 11:59 PM.'));
    strict_1.default.equal(r.claims.find(c => c.field === 'application_deadline')?.value, '2026-08-28T23:59:00-04:00');
});
(0, node_test_1.default)('does not confuse info session with deadline', () => {
    const r = (0, extractor_1.heuristicExtract)(src('Info session: August 28 at 6 PM\nApplications are due September 3 at 11:59 PM'));
    strict_1.default.equal(r.claims.find(c => c.field === 'application_deadline')?.value, '2026-09-03T23:59:00-04:00');
    strict_1.default.equal((r.claims.find(c => c.field === 'event')?.value).startsAt, '2026-08-28T18:00:00-04:00');
});
(0, node_test_1.default)('extracts open state', () => strict_1.default.equal((0, extractor_1.heuristicExtract)(src('Applications are now open!')).claims.find(c => c.field === 'application_open')?.value, true));
(0, node_test_1.default)('extracts closed form state', () => strict_1.default.equal((0, extractor_1.heuristicExtract)(src('This form is no longer accepting responses.')).claims.find(c => c.field === 'application_open')?.value, false));
(0, node_test_1.default)('extracts application URL', () => strict_1.default.equal((0, extractor_1.heuristicExtract)(src('Apply here https://forms.gle/abc')).claims.find(c => c.field === 'application_url')?.value, 'https://forms.gle/abc'));
(0, node_test_1.default)('resolver marks past deadline stale', async () => {
    const st = new store_1.Store();
    st.upsertOrganization({ id: 'org1', name: 'X', school: 'UNC' });
    const ing = new ingest_1.IngestionService(st, extractor_1.fallbackExtractor);
    await ing.ingest(src('Applications are due August 20 at 11:59 PM'), { followLinks: false });
    const o = (0, resolver_1.resolveOrganization)(st, 'org1', new Date('2026-08-27T12:00:00Z')).find(x => x.kind === 'application');
    strict_1.default.equal(o?.stale, true);
    st.close();
});
(0, node_test_1.default)('newer open claim suppresses older deadline', async () => {
    const st = new store_1.Store();
    st.upsertOrganization({ id: 'org1', name: 'X', school: 'UNC' });
    const ing = new ingest_1.IngestionService(st, extractor_1.fallbackExtractor);
    await ing.ingest(src('Applications due August 20 at 11:59 PM', { id: 'old', publishedAt: '2026-08-10T12:00:00Z' }), { followLinks: false });
    await ing.ingest(src('Applications are now open!', { id: 'new', sourceType: 'instagram', publishedAt: '2026-08-27T12:00:00Z' }), { followLinks: false });
    const o = (0, resolver_1.resolveOrganization)(st, 'org1', new Date('2026-08-27T12:00:00Z')).find(x => x.kind === 'application');
    strict_1.default.equal(o?.deadlineAt, undefined);
    strict_1.default.equal(o?.stale, false);
    st.close();
});
(0, node_test_1.default)('explicit closed claim wins', async () => {
    const st = new store_1.Store();
    st.upsertOrganization({ id: 'org1', name: 'X', school: 'UNC' });
    const ing = new ingest_1.IngestionService(st, extractor_1.fallbackExtractor);
    await ing.ingest(src('Applications due September 30 at 11:59 PM', { id: 'a', publishedAt: '2026-08-20T12:00:00Z' }), { followLinks: false });
    await ing.ingest(src('Applications are closed.', { id: 'b', sourceType: 'application', publishedAt: '2026-08-27T12:00:00Z' }), { followLinks: false });
    strict_1.default.equal((0, resolver_1.resolveOrganization)(st, 'org1', new Date('2026-08-27T12:00:00Z')).find(x => x.kind === 'application')?.stale, true);
    st.close();
});
