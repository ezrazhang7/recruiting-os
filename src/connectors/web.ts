import type { HttpClient, SourceItem, SourceType } from '../types';
import { assertPublicHttpUrl, classifyUrl } from '../url';
import { extractUrls, nowIso, stableId } from '../lib/util';
import { SafeHttpClient } from '../infrastructure/outbound-http/safe-http-client';

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}
function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}
function linksFromHtml(html: string, base: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)) {
    const href = m[1];
    if (!href) continue;
    try {
      out.push(new URL(decodeEntities(href), base).toString());
    } catch {
      /* Ignore malformed page links. */
    }
  }
  return [...new Set(out)];
}
function titleFromHtml(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m?.[1] ? stripTags(m[1]) : undefined;
}

export class WebConnector {
  constructor(
    private http: HttpClient = new SafeHttpClient().fetch,
    private validate: (u: string) => Promise<URL> = assertPublicHttpUrl,
  ) {}
  async fetchSource(
    orgId: string,
    url: string,
    sourceType?: SourceType,
  ): Promise<{ source: SourceItem; links: string[] }> {
    await this.validate(url);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const r = await this.http(url, {
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'user-agent': 'RecruitingOS/0.2 (+campus recruiting aggregator)' },
      });
      if (!r.ok) throw new Error(`Fetch failed ${r.status}: ${url}`);
      const ct = r.headers.get('content-type') ?? '';
      const finalUrl = r.url || url;
      if (!ct.includes('text/html') && !ct.includes('text/plain'))
        throw new Error(`Unsupported content-type ${ct}`);
      const body = await r.text();
      const links = ct.includes('html') ? linksFromHtml(body, finalUrl) : extractUrls(body);
      const kind = classifyUrl(finalUrl);
      const st =
        sourceType ??
        (kind === 'application' ? 'application' : kind === 'bio_link' ? 'bio_link' : 'website');
      const text = ct.includes('html') ? stripTags(body) : body;
      const source: SourceItem = {
        id: stableId('src', `${st}:${finalUrl}:${text.slice(0, 500)}`),
        organizationId: orgId,
        sourceType: st,
        externalId: `${st}:${finalUrl}`,
        url: finalUrl,
        title: ct.includes('html') ? titleFromHtml(body) : undefined,
        rawText: text,
        media: [],
        fetchedAt: nowIso(),
        metadata: { contentType: ct },
      };
      return { source, links };
    } finally {
      clearTimeout(timer);
    }
  }
}
