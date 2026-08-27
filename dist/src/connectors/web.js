"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebConnector = void 0;
const url_1 = require("../url");
const util_1 = require("../lib/util");
function decodeEntities(s) { return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>'); }
function stripTags(html) { return decodeEntities(html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()); }
function linksFromHtml(html, base) {
    const out = [];
    for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)) {
        try {
            out.push(new URL(decodeEntities(m[1]), base).toString());
        }
        catch { }
    }
    return [...new Set(out)];
}
function titleFromHtml(html) { const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i); return m ? stripTags(m[1]) : undefined; }
class WebConnector {
    http;
    validate;
    constructor(http = fetch, validate = url_1.assertPublicHttpUrl) {
        this.http = http;
        this.validate = validate;
    }
    async fetchSource(orgId, url, sourceType) {
        await this.validate(url);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 12000);
        try {
            const r = await this.http(url, { redirect: 'follow', signal: ctrl.signal, headers: { 'user-agent': 'RecruitingOS/0.1 (+campus recruiting aggregator)' } });
            if (!r.ok)
                throw new Error(`Fetch failed ${r.status}: ${url}`);
            const ct = r.headers.get('content-type') ?? '';
            const finalUrl = r.url || url;
            if (!ct.includes('text/html') && !ct.includes('text/plain'))
                throw new Error(`Unsupported content-type ${ct}`);
            const body = await r.text();
            const links = ct.includes('html') ? linksFromHtml(body, finalUrl) : (0, util_1.extractUrls)(body);
            const kind = (0, url_1.classifyUrl)(finalUrl);
            const st = sourceType ?? (kind === 'application' ? 'application' : kind === 'bio_link' ? 'bio_link' : 'website');
            const text = ct.includes('html') ? stripTags(body) : body;
            const source = { id: (0, util_1.stableId)('src', `${st}:${finalUrl}:${text.slice(0, 500)}`), organizationId: orgId, sourceType: st, externalId: `${st}:${finalUrl}`, url: finalUrl, title: ct.includes('html') ? titleFromHtml(body) : undefined, rawText: text, media: [], fetchedAt: (0, util_1.nowIso)(), metadata: { contentType: ct } };
            return { source, links };
        }
        finally {
            clearTimeout(timer);
        }
    }
}
exports.WebConnector = WebConnector;
