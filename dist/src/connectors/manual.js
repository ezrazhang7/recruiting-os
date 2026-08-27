"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.screenshotSource = screenshotSource;
const util_1 = require("../lib/util");
function screenshotSource(orgId, input) {
    return { id: (0, util_1.stableId)('src', `screenshot:${orgId}:${input.base64.slice(0, 64)}:${input.note ?? ''}`), organizationId: orgId, sourceType: 'screenshot', url: input.url, title: 'Manual screenshot', rawText: input.note ?? '', media: [{ type: 'image', base64: input.base64, mimeType: input.mimeType ?? 'image/png' }], publishedAt: input.publishedAt, fetchedAt: (0, util_1.nowIso)() };
}
