import type { HttpClient, MediaRef, SourceItem } from '../types';
import type { RecruitingRepository } from '../application/ports/recruiting-repository';
import { nowIso, stableId } from '../lib/util';
import { ProviderHttpClient } from '../infrastructure/outbound-http/provider-http-client';

const b64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const header = (hs: any[] | undefined, n: string) =>
  hs?.find((h) => String(h.name).toLowerCase() === n.toLowerCase())?.value;
function walkParts(payload: any): any[] {
  return [payload, ...(payload?.parts ?? []).flatMap(walkParts)];
}

export class GmailConnector {
  constructor(
    private token: string,
    private userId = 'me',
    private http: HttpClient = new ProviderHttpClient({
      allowedHosts: new Set(['gmail.googleapis.com']),
    }).fetch,
  ) {}
  private async req(path: string, init?: RequestInit): Promise<any> {
    const r = await this.http(
      `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(this.userId)}${path}`,
      {
        ...init,
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
          ...(init?.headers ?? {}),
        },
      },
    );
    if (!r.ok) throw new Error(`Gmail ${r.status}: ${await r.text()}`);
    return r.json();
  }
  async watch(topicName: string, labelIds = ['INBOX']) {
    return this.req('/watch', {
      method: 'POST',
      body: JSON.stringify({ topicName, labelIds, labelFilterBehavior: 'include' }),
    });
  }
  decodePush(data: string): { emailAddress: string; historyId: string } {
    return JSON.parse(b64url(data).toString('utf8'));
  }
  async history(startHistoryId: string): Promise<any> {
    return this.req(
      `/history?startHistoryId=${encodeURIComponent(startHistoryId)}&historyTypes=messageAdded&labelId=INBOX`,
    );
  }
  async message(id: string): Promise<any> {
    return this.req(`/messages/${id}?format=full`);
  }
  async attachment(messageId: string, attachmentId: string): Promise<Buffer> {
    const x = await this.req(`/messages/${messageId}/attachments/${attachmentId}`);
    return b64url(x.data);
  }

  async toSource(orgId: string, msg: any): Promise<SourceItem> {
    const parts = walkParts(msg.payload);
    const texts = parts
      .filter((p) => p.mimeType === 'text/plain' && p.body?.data)
      .map((p) => b64url(p.body.data).toString('utf8'));
    const htmls = parts
      .filter((p) => p.mimeType === 'text/html' && p.body?.data)
      .map((p) =>
        b64url(p.body.data)
          .toString('utf8')
          .replace(/<[^>]+>/g, ' '),
      );
    const media: MediaRef[] = [];
    for (const p of parts) {
      if (String(p.mimeType ?? '').startsWith('image/') && p.body?.attachmentId) {
        const bytes = await this.attachment(msg.id, p.body.attachmentId);
        media.push({
          type: 'image',
          base64: bytes.toString('base64'),
          mimeType: p.mimeType,
          alt: p.filename,
        });
      }
    }
    const hs = msg.payload?.headers;
    const internal = Number(msg.internalDate || 0);
    return {
      id: stableId('src', `gmail:${msg.id}`),
      organizationId: orgId,
      sourceType: 'gmail',
      externalId: msg.id,
      url: `https://mail.google.com/mail/#all/${msg.id}`,
      title: header(hs, 'Subject'),
      rawText: texts[0] ?? htmls[0] ?? msg.snippet ?? '',
      media,
      publishedAt: internal ? new Date(internal).toISOString() : undefined,
      fetchedAt: nowIso(),
      metadata: { from: header(hs, 'From'), to: header(hs, 'To'), threadId: msg.threadId },
    };
  }

  async sync(
    store: RecruitingRepository,
    resolveOrg: (msg: any) => string | undefined,
    tenantId?: string,
  ): Promise<SourceItem[]> {
    const state = await store.getConnectorState('gmail', this.userId, tenantId);
    if (!state.cursor)
      throw new Error('No Gmail history cursor. Call watch() and persist its historyId first.');
    let h: any;
    try {
      h = await this.history(state.cursor);
    } catch (e) {
      if (String(e).includes('404'))
        throw new Error(
          'Gmail history cursor expired; perform a bounded recent-message resync, then reset cursor.',
        );
      throw e;
    }
    const ids = [
      ...new Set(
        (h.history ?? []).flatMap((x: any) =>
          (x.messagesAdded ?? []).map((m: any) => m.message.id),
        ),
      ),
    ] as string[];
    const out: SourceItem[] = [];
    for (const id of ids) {
      const msg = await this.message(id);
      const orgId = resolveOrg(msg);
      if (orgId) out.push(await this.toSource(orgId, msg));
    }
    await store.setConnectorState(
      'gmail',
      this.userId,
      String(h.historyId ?? state.cursor),
      {},
      tenantId,
    );
    return out;
  }

  async initialize(
    store: RecruitingRepository,
    orgId: string,
    query: string,
    tenantId?: string,
  ): Promise<SourceItem[]> {
    const listing = await this.req(`/messages?maxResults=50&q=${encodeURIComponent(query)}`);
    const out: SourceItem[] = [];
    for (const item of listing.messages ?? []) {
      const message = await this.message(item.id);
      out.push(await this.toSource(orgId, message));
    }
    const profile = await this.req('/profile');
    await store.setConnectorState('gmail', this.userId, String(profile.historyId), {}, tenantId);
    return out;
  }

  async synchronize(
    store: RecruitingRepository,
    orgId: string,
    query: string,
    tenantId?: string,
  ): Promise<SourceItem[]> {
    const state = await store.getConnectorState('gmail', this.userId, tenantId);
    if (!state.cursor) return this.initialize(store, orgId, query, tenantId);
    try {
      return await this.sync(store, () => orgId, tenantId);
    } catch (error) {
      if (!String(error).includes('history cursor expired')) throw error;
      return this.initialize(store, orgId, query, tenantId);
    }
  }
}
