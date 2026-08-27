"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stableId = exports.uid = exports.nowIso = void 0;
exports.stripTrailingPunctuation = stripTrailingPunctuation;
exports.extractUrls = extractUrls;
exports.parseJsonSafe = parseJsonSafe;
exports.clamp01 = clamp01;
exports.normalizeHandle = normalizeHandle;
const node_crypto_1 = require("node:crypto");
const nowIso = () => new Date().toISOString();
exports.nowIso = nowIso;
const uid = (prefix) => `${prefix}_${(0, node_crypto_1.randomUUID)()}`;
exports.uid = uid;
const stableId = (prefix, value) => `${prefix}_${(0, node_crypto_1.createHash)('sha256').update(value).digest('hex').slice(0, 24)}`;
exports.stableId = stableId;
function stripTrailingPunctuation(url) {
    return url.replace(/[),.;!?]+$/g, '');
}
function extractUrls(text) {
    const hits = text.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
    return [...new Set(hits.map(stripTrailingPunctuation))];
}
function parseJsonSafe(value, fallback) {
    try {
        return JSON.parse(value);
    }
    catch {
        return fallback;
    }
}
function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function normalizeHandle(v) {
    return v.trim().replace(/^@/, '').toLowerCase();
}
