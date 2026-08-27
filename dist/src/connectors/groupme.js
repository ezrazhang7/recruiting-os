"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GroupMeConnector = void 0;
exports.groupMeOAuthUrl = groupMeOAuthUrl;
const util_1 = require("../lib/util");
const API = 'https://api.groupme.com/v3';
function groupMeOAuthUrl(clientId, redirectUri) {
    const u = new URL('https://oauth.groupme.com/oauth/authorize');
    u.searchParams.set('client_id', clientId);
    if (redirectUri)
        u.searchParams.set('redirect_uri', redirectUri);
    return u.toString();
}
class GroupMeConnector {
    token;
    http;
    constructor(token, http = fetch) {
        this.token = token;
        this.http = http;
    }
    async get(path) { const r = await this.http(`${API}${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(this.token)}`); if (!r.ok)
        throw new Error(`GroupMe ${r.status}`); return (await r.json()).response; }
    async groups() { return this.get('/groups?per_page=100'); }
    async messages(groupId, afterId) { const q = new URLSearchParams({ limit: '100' }); if (afterId)
        q.set('after_id', afterId); const r = await this.get(`/groups/${encodeURIComponent(groupId)}/messages?${q}`); return r.messages ?? []; }
    async syncGroup(store, orgId, groupId) {
        const state = store.getConnectorState('groupme', groupId);
        const msgs = await this.messages(groupId, state.cursor);
        const out = [];
        const sorted = msgs.slice().sort((a, b) => Number(a.created_at) - Number(b.created_at));
        for (const m of sorted) {
            const media = (m.attachments ?? []).flatMap((a) => a.type === 'image' && a.url ? [{ type: 'image', url: a.url }] : []);
            out.push({ id: (0, util_1.stableId)('src', `groupme:${groupId}:${m.id}`), organizationId: orgId, sourceType: 'groupme', externalId: `${groupId}:${m.id}`, url: `https://groupme.com/chats/${groupId}`, title: m.name ? `GroupMe — ${m.name}` : 'GroupMe message', rawText: m.text ?? '', media, publishedAt: new Date(Number(m.created_at) * 1000).toISOString(), fetchedAt: (0, util_1.nowIso)(), metadata: { groupId, messageId: m.id, senderId: m.user_id } });
        }
        if (sorted.length)
            store.setConnectorState('groupme', groupId, String(sorted.at(-1).id));
        return out;
    }
}
exports.GroupMeConnector = GroupMeConnector;
