"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_http_1 = require("node:http");
const store_1 = require("./store");
const extractor_1 = require("./extractor");
const ingest_1 = require("./ingest");
const web_1 = require("./connectors/web");
const manual_1 = require("./connectors/manual");
const port = Number(process.env.PORT ?? 4318);
const path = process.env.DATABASE_PATH ?? './data/recruiting-os.sqlite';
const store = new store_1.Store(path);
const extractor = new extractor_1.OpenAIExtractor(process.env.OPENAI_API_KEY ?? '', process.env.OPENAI_MODEL ?? 'gpt-5-mini');
const ingest = new ingest_1.IngestionService(store, extractor, new web_1.WebConnector());
const json = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj, null, 2)); };
const server = (0, node_http_1.createServer)(async (req, res) => {
    try {
        const u = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        if (req.method === 'GET' && u.pathname === '/api/dashboard')
            return json(res, 200, { organizations: store.listOrganizations().map(o => ({ ...o, opportunities: store.listOpportunities(o.id) })) });
        if (req.method === 'GET' && u.pathname.startsWith('/api/organizations/')) {
            const id = u.pathname.split('/').at(-1);
            return json(res, 200, { organization: store.getOrganization(id), claims: store.listClaims(id), opportunities: store.listOpportunities(id) });
        }
        if (req.method === 'POST' && u.pathname === '/api/organizations') {
            const body = await readJson(req);
            store.upsertOrganization(body);
            return json(res, 201, body);
        }
        if (req.method === 'POST' && u.pathname === '/api/ingest/url') {
            const body = await readJson(req);
            const fetched = await new web_1.WebConnector().fetchSource(body.organizationId, body.url);
            await ingest.ingest(fetched.source, { followLinks: true, maxDepth: 2 });
            return json(res, 201, { ok: true });
        }
        if (req.method === 'POST' && u.pathname === '/api/ingest/screenshot') {
            const body = await readJson(req);
            await ingest.ingest((0, manual_1.screenshotSource)(body.organizationId, body), { followLinks: true });
            return json(res, 201, { ok: true });
        }
        if (req.method === 'GET' && u.pathname === '/') {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            return res.end(`<!doctype html><meta charset=utf-8><title>Recruiting OS</title><style>body{font:16px system-ui;margin:40px;max-width:1000px}pre{white-space:pre-wrap;background:#f4f4f5;padding:16px;border-radius:12px}</style><h1>Recruiting OS</h1><p>Evidence-first recruiting reconciliation. JSON dashboard: <a href=/api/dashboard>/api/dashboard</a>.</p><pre id=x>Loading…</pre><script>fetch('/api/dashboard').then(r=>r.json()).then(x=>document.querySelector('#x').textContent=JSON.stringify(x,null,2))</script>`);
        }
        json(res, 404, { error: 'Not found' });
    }
    catch (e) {
        json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
});
function readJson(req) { return new Promise((resolve, reject) => { let s = ''; req.on('data', (c) => s += c); req.on('end', () => { try {
    resolve(JSON.parse(s || '{}'));
}
catch (e) {
    reject(e);
} }); req.on('error', reject); }); }
server.listen(port, () => console.log(`Recruiting OS on http://localhost:${port}`));
