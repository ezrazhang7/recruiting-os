"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const groupme_1 = require("../src/connectors/groupme");
const gmail_1 = require("../src/connectors/gmail");
const instagram_1 = require("../src/connectors/instagram");
const linkedin_1 = require("../src/connectors/linkedin");
const web_1 = require("../src/connectors/web");
const store_1 = require("../src/store");
const jsonResponse = (x, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });
(0, node_test_1.default)('GroupMe OAuth includes client id', () => strict_1.default.match((0, groupme_1.groupMeOAuthUrl)('abc'), /client_id=abc/));
(0, node_test_1.default)('GroupMe incremental sync uses cursor and returns image', async () => {
    let requested = '';
    const http = async (input) => { requested = String(input); return jsonResponse({ response: { messages: [{ id: 'm2', created_at: 2, text: 'Apps due Friday', user_id: 'u', attachments: [{ type: 'image', url: 'https://i.groupme.com/x.jpg' }] }] } }); };
    const st = new store_1.Store();
    st.setConnectorState('groupme', 'g1', 'm1');
    const xs = await new groupme_1.GroupMeConnector('tok', http).syncGroup(st, 'org', 'g1');
    strict_1.default.match(requested, /after_id=m1/);
    strict_1.default.equal(xs[0].media[0].url, 'https://i.groupme.com/x.jpg');
    strict_1.default.equal(st.getConnectorState('groupme', 'g1').cursor, 'm2');
    st.close();
});
(0, node_test_1.default)('Gmail push decoder', () => {
    const g = new gmail_1.GmailConnector('x');
    const d = Buffer.from(JSON.stringify({ emailAddress: 'a@b.com', historyId: '42' })).toString('base64url');
    strict_1.default.equal(g.decodePush(d).historyId, '42');
});
(0, node_test_1.default)('Gmail MIME parser downloads image attachment', async () => {
    const http = async (input) => String(input).includes('/attachments/') ? jsonResponse({ data: Buffer.from('png').toString('base64url') }) : jsonResponse({});
    const g = new gmail_1.GmailConnector('x', 'me', http);
    const msg = { id: 'm', threadId: 't', internalDate: '1', payload: { headers: [{ name: 'Subject', value: 'Recruiting' }], parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('Apps due Aug 28').toString('base64url') } }, { mimeType: 'image/png', filename: 'flyer.png', body: { attachmentId: 'a1' } }] } };
    const s = await g.toSource('org', msg);
    strict_1.default.match(s.rawText, /Apps due/);
    strict_1.default.equal(s.media[0].base64, Buffer.from('png').toString('base64'));
});
(0, node_test_1.default)('Gmail sync requires persisted history cursor', async () => { const st = new store_1.Store(); await strict_1.default.rejects(() => new gmail_1.GmailConnector('x').sync(st, () => undefined), /No Gmail history cursor/); st.close(); });
(0, node_test_1.default)('Instagram business discovery parses carousel images', async () => {
    const http = async () => jsonResponse({ business_discovery: { username: 'unc180dc', website: 'https://x.com', media: { data: [{ id: 'p1', caption: 'Apply now', media_type: 'CAROUSEL_ALBUM', permalink: 'https://instagram.com/p/p1', timestamp: '2026-08-27T00:00:00Z', children: { data: [{ media_type: 'IMAGE', media_url: 'https://img/1.jpg' }, { media_type: 'IMAGE', media_url: 'https://img/2.jpg' }] } }] } } });
    const x = await new instagram_1.InstagramConnector('tok', 'me', 'v24.0', http).sourcesForOrganization('org', '@unc180dc');
    strict_1.default.equal(x.sources[0].media.length, 2);
    strict_1.default.equal(x.profile.website, 'https://x.com');
});
(0, node_test_1.default)('Instagram handle normalization', async () => {
    let url = '';
    const http = async (input) => { url = String(input); return jsonResponse({ business_discovery: { media: { data: [] } } }); };
    await new instagram_1.InstagramConnector('t', 'me', 'v24.0', http).businessDiscovery('@UNC180DC');
    strict_1.default.match(decodeURIComponent(url), /username\(unc180dc\)/);
});
(0, node_test_1.default)('LinkedIn vanity extraction', () => strict_1.default.equal((0, linkedin_1.linkedinVanityName)('https://www.linkedin.com/company/180-degrees-consulting-unc/'), '180-degrees-consulting-unc'));
(0, node_test_1.default)('LinkedIn vanity resolution', async () => { const http = async () => jsonResponse({ elements: [{ id: 123 }] }); strict_1.default.equal(await new linkedin_1.LinkedInConnector('t', '202608', http).resolveOrganizationUrn('https://linkedin.com/company/foo'), 'urn:li:organization:123'); });
(0, node_test_1.default)('LinkedIn post hydrates image', async () => {
    const http = async (input) => String(input).includes('/images/') ? jsonResponse({ downloadUrl: 'https://img/li.jpg' }) : jsonResponse({ elements: [{ id: 'urn:li:share:1', author: 'urn:li:organization:1', commentary: 'Apps open', publishedAt: 1, content: { media: { id: 'urn:li:image:1' } } }] });
    const x = await new linkedin_1.LinkedInConnector('t', '202608', http).posts('org', 'urn:li:organization:1');
    strict_1.default.equal(x[0].media[0].url, 'https://img/li.jpg');
});
(0, node_test_1.default)('Web connector extracts links and visible text', async () => {
    const http = async () => new Response('<title>Recruit</title><a href="https://forms.gle/abc">Apply</a><p>Apps open</p>', { status: 200, headers: { 'content-type': 'text/html' } });
    const web = new web_1.WebConnector(http, async (u) => new URL(u));
    const x = await web.fetchSource('org', 'https://club.example/recruit');
    strict_1.default.equal(x.links[0], 'https://forms.gle/abc');
    strict_1.default.match(x.source.rawText, /Apps open/);
});
(0, node_test_1.default)('Web connector classifies form as application', async () => { const http = async () => new Response('no longer accepting responses', { status: 200, headers: { 'content-type': 'text/plain' } }); const web = new web_1.WebConnector(http, async (u) => new URL(u)); strict_1.default.equal((await web.fetchSource('org', 'https://forms.gle/abc')).source.sourceType, 'application'); });
