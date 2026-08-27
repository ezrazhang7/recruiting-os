"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InstagramConnector = void 0;
const util_1 = require("../lib/util");
class InstagramConnector {
    token;
    igUserId;
    apiVersion;
    http;
    constructor(token, igUserId, apiVersion = 'v24.0', http = fetch) {
        this.token = token;
        this.igUserId = igUserId;
        this.apiVersion = apiVersion;
        this.http = http;
    }
    async get(url) { const r = await this.http(url); if (!r.ok)
        throw new Error(`Instagram ${r.status}: ${await r.text()}`); return r.json(); }
    async businessDiscovery(handle, limit = 25) {
        const h = (0, util_1.normalizeHandle)(handle);
        const fields = `business_discovery.username(${h}){id,username,name,biography,website,profile_picture_url,media.limit(${limit}){id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,children{media_type,media_url,thumbnail_url}}}`;
        const u = new URL(`https://graph.facebook.com/${this.apiVersion}/${this.igUserId}`);
        u.searchParams.set('fields', fields);
        u.searchParams.set('access_token', this.token);
        const data = await this.get(u.toString());
        const p = data.business_discovery;
        if (!p)
            throw new Error(`No business_discovery result for @${h}`);
        const sources = (p.media?.data ?? []).map((m) => {
            const media = [];
            const add = (x) => { const url = x.media_type === 'VIDEO' ? (x.thumbnail_url || x.media_url) : x.media_url; if (url)
                media.push({ type: 'image', url }); };
            add(m);
            for (const c of m.children?.data ?? [])
                add(c);
            return { id: (0, util_1.stableId)('src', `instagram:${m.id}`), organizationId: '', sourceType: 'instagram', externalId: m.id, url: m.permalink, title: `Instagram @${h}`, rawText: m.caption ?? '', media, publishedAt: m.timestamp, fetchedAt: (0, util_1.nowIso)(), metadata: { handle: h, mediaType: m.media_type } };
        });
        return { profile: p, sources };
    }
    async sourcesForOrganization(orgId, handle, limit = 25) { const x = await this.businessDiscovery(handle, limit); return { profile: x.profile, sources: x.sources.map(s => ({ ...s, organizationId: orgId })) }; }
}
exports.InstagramConnector = InstagramConnector;
