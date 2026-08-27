"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fallbackExtractor = exports.OpenAIExtractor = void 0;
exports.heuristicExtract = heuristicExtract;
const date_1 = require("./lib/date");
const util_1 = require("./lib/util");
function dateFromText(s, publishedAt) {
    const iso = s.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/);
    if (iso)
        return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
    const months = { jan: '01', january: '01', feb: '02', february: '02', mar: '03', march: '03', apr: '04', april: '04', may: '05', jun: '06', june: '06', jul: '07', july: '07', aug: '08', august: '08', sep: '09', sept: '09', september: '09', oct: '10', october: '10', nov: '11', november: '11', dec: '12', december: '12' };
    const m = s.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(20\d{2}))?/i);
    if (m) {
        const year = m[3] ?? (publishedAt ? String(new Date(publishedAt).getUTCFullYear()) : String(new Date().getUTCFullYear()));
        return `${year}-${months[m[1].toLowerCase().replace('.', '')]}-${m[2].padStart(2, '0')}`;
    }
    const wd = s.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
    return wd ? (0, date_1.resolveRelativeWeekday)(wd[1], publishedAt) : undefined;
}
function timeFromText(s) {
    const m = s.match(/\b(1[0-2]|0?\d)(?::([0-5]\d))?\s*(am|pm)\b/i);
    return m ? `${m[1]}:${m[2] ?? '00'} ${m[3]}` : undefined;
}
function heuristicExtract(source) {
    const text = source.rawText.replace(/\r/g, '');
    const lines = text.split('\n').map(x => x.trim()).filter(Boolean);
    const claims = [];
    const discoveredUrls = (0, util_1.extractUrls)(text);
    if (/no longer accepting responses|applications? (?:are )?closed|application closed|closed for applications/i.test(text)) {
        claims.push({ field: 'application_open', value: false, confidence: .98, evidence: 'Explicit closed-language in source' });
        claims.push({ field: 'status', value: 'closed', confidence: .98, evidence: 'Explicit closed-language in source' });
    }
    if (/applications? (?:are )?(?:now )?(?:open|live)|apply now|accepting applications/i.test(text)) {
        claims.push({ field: 'application_open', value: true, confidence: .92, evidence: 'Explicit open-language in source' });
    }
    for (const line of lines) {
        if (/application|apply|submission/i.test(line) && /due|deadline|close[sd]?/i.test(line)) {
            // Anchor date extraction to the sentence/phrase that actually contains the application deadline.
            // A recruiting page often lists an info-session date before the application deadline on the same rendered line.
            const relevant = line.match(/(?:applications?|apply|submissions?)[^.\n]{0,140}(?:due|deadline|close[sd]?)[^.\n]{0,140}/i)?.[0] ?? line;
            const date = dateFromText(relevant, source.publishedAt);
            if (date) {
                claims.push({ field: 'application_deadline', value: (0, date_1.combineDateTime)(date, timeFromText(relevant)), confidence: .94, evidence: relevant });
            }
        }
        if (/interest meeting|info(?:rmation)? session|coffee chat|recruit(?:ing|ment) event|boot\s?camp|expo/i.test(line)) {
            const date = dateFromText(line, source.publishedAt);
            const time = timeFromText(line);
            if (date)
                claims.push({ field: 'event', value: { title: line.replace(/https?:\/\/\S+/g, '').slice(0, 160), startsAt: (0, date_1.combineDateTime)(date, time), url: (0, util_1.extractUrls)(line)[0] }, confidence: .84, evidence: line });
        }
    }
    for (const url of discoveredUrls) {
        if (/forms\.gle|docs\.google\.com\/forms|qualtrics|\/apply/i.test(url))
            claims.push({ field: 'application_url', value: url, confidence: .9, evidence: `Application-like URL: ${url}` });
    }
    const handles = [...text.matchAll(/(?:instagram|ig)\s*[:@]?\s*@?([a-z0-9._]{3,30})/gi)];
    for (const h of handles)
        claims.push({ field: 'social_handle', value: { platform: 'instagram', handle: h[1] }, confidence: .72, evidence: h[0] });
    return { claims, discoveredUrls };
}
class OpenAIExtractor {
    apiKey;
    model;
    http;
    constructor(apiKey, model = 'gpt-5-mini', http = fetch) {
        this.apiKey = apiKey;
        this.model = model;
        this.http = http;
    }
    async extract(source) {
        if (!this.apiKey)
            return heuristicExtract(source);
        const media = source.media.filter(m => m.type === 'image' && (m.url || m.base64));
        const content = [{ type: 'input_text', text: `Source type: ${source.sourceType}\nPublished at: ${source.publishedAt ?? 'unknown'}\nURL: ${source.url ?? ''}\n\n${source.rawText}` }];
        for (const m of media) {
            const imageUrl = m.url ?? `data:${m.mimeType ?? 'image/png'};base64,${m.base64}`;
            content.push({ type: 'input_image', image_url: imageUrl, detail: 'high' });
        }
        const body = { model: this.model, input: [{ role: 'system', content: [{ type: 'input_text', text: 'Extract recruiting facts only. Never invent dates. Distinguish application deadlines from event dates. If relative dates appear, use published_at to resolve them. Return URLs exactly.' }] }, { role: 'user', content }], text: { format: { type: 'json_schema', name: 'recruiting_extraction', strict: true, schema: { type: 'object', additionalProperties: false, properties: { claims: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { field: { type: 'string', enum: ['application_open', 'application_deadline', 'application_url', 'event', 'requirement', 'status', 'social_handle', 'recruiting_note'] }, value: {}, confidence: { type: 'number' }, evidence: { type: 'string' } }, required: ['field', 'value', 'confidence', 'evidence'] } }, discoveredUrls: { type: 'array', items: { type: 'string' } } }, required: ['claims', 'discoveredUrls'] } } } };
        const r = await this.http('https://api.openai.com/v1/responses', { method: 'POST', headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
        if (!r.ok)
            throw new Error(`OpenAI extraction failed: ${r.status} ${await r.text()}`);
        const json = await r.json();
        const outputText = json.output_text ?? json.output?.flatMap((o) => o.content ?? []).find((x) => x.type === 'output_text')?.text;
        if (!outputText)
            throw new Error('OpenAI response had no output_text');
        return JSON.parse(outputText);
    }
}
exports.OpenAIExtractor = OpenAIExtractor;
exports.fallbackExtractor = { extract: async (s) => heuristicExtract(s) };
