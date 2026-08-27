"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IngestionService = void 0;
const url_1 = require("./url");
const util_1 = require("./lib/util");
const resolver_1 = require("./resolver");
class IngestionService {
    store;
    extractor;
    web;
    constructor(store, extractor, web) {
        this.store = store;
        this.extractor = extractor;
        this.web = web;
    }
    async ingest(source, { followLinks = true, maxDepth = 2 } = {}) {
        const inserted = this.store.putSource(source);
        if (!inserted)
            return;
        const result = await this.extractor.extract(source);
        const claims = result.claims.map((c, i) => ({
            id: (0, util_1.stableId)('clm', `${source.id}:${i}:${c.field}:${JSON.stringify(c.value)}`), organizationId: source.organizationId, sourceItemId: source.id, field: c.field, value: c.value, confidence: c.confidence, publishedAt: source.publishedAt, extractedAt: (0, util_1.nowIso)(), evidence: c.evidence
        }));
        this.store.putClaims(claims);
        if (followLinks && this.web && maxDepth > 0) {
            const candidates = [...new Set(result.discoveredUrls)].filter(u => ['application', 'bio_link', 'website'].includes((0, url_1.classifyUrl)(u)));
            for (const url of candidates.slice(0, 12)) {
                try {
                    const { source: child, links } = await this.web.fetchSource(source.organizationId, url);
                    await this.ingest(child, { followLinks: false });
                    if (maxDepth > 1 && (0, url_1.classifyUrl)(url) === 'bio_link') {
                        for (const next of links.filter(x => ['application', 'website'].includes((0, url_1.classifyUrl)(x))).slice(0, 10)) {
                            try {
                                const fetched = await this.web.fetchSource(source.organizationId, next);
                                await this.ingest(fetched.source, { followLinks: false });
                            }
                            catch { }
                        }
                    }
                }
                catch { }
            }
        }
        (0, resolver_1.resolveOrganization)(this.store, source.organizationId);
    }
}
exports.IngestionService = IngestionService;
