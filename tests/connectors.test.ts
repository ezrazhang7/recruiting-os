import test from 'node:test';
import assert from 'node:assert/strict';
import { GroupMeConnector, groupMeOAuthUrl } from '../src/connectors/groupme';
import { GmailConnector } from '../src/connectors/gmail';
import { InstagramConnector } from '../src/connectors/instagram';
import { LinkedInConnector, linkedinVanityName } from '../src/connectors/linkedin';
import { WebConnector } from '../src/connectors/web';
import { Store } from '../src/store';

const jsonResponse = (x: any, status = 200) =>
  new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });

test('GroupMe OAuth includes client id', () =>
  assert.match(groupMeOAuthUrl('abc'), /client_id=abc/));
test('GroupMe incremental sync uses cursor and returns image', async () => {
  let requested = '';
  const http: any = async (input: any) => {
    requested = String(input);
    return jsonResponse({
      response: {
        messages: [
          {
            id: 'm2',
            created_at: 2,
            text: 'Apps due Friday',
            user_id: 'u',
            attachments: [{ type: 'image', url: 'https://i.groupme.com/x.jpg' }],
          },
        ],
      },
    });
  };
  const st = new Store();
  await st.setConnectorState('groupme', 'g1', 'm1');
  const xs = await new GroupMeConnector('tok', http).syncGroup(st, 'org', 'g1');
  assert.match(requested, /after_id=m1/);
  assert.equal(xs[0]?.media[0]?.url, 'https://i.groupme.com/x.jpg');
  assert.equal((await st.getConnectorState('groupme', 'g1')).cursor, 'm2');
  await st.close();
});

test('Gmail push decoder', () => {
  const g = new GmailConnector('x');
  const d = Buffer.from(JSON.stringify({ emailAddress: 'a@b.com', historyId: '42' })).toString(
    'base64url',
  );
  assert.equal(g.decodePush(d).historyId, '42');
});
test('Gmail MIME parser downloads image attachment', async () => {
  const http: any = async (input: any) =>
    String(input).includes('/attachments/')
      ? jsonResponse({ data: Buffer.from('png').toString('base64url') })
      : jsonResponse({});
  const g = new GmailConnector('x', 'me', http);
  const msg = {
    id: 'm',
    threadId: 't',
    internalDate: '1',
    payload: {
      headers: [{ name: 'Subject', value: 'Recruiting' }],
      parts: [
        {
          mimeType: 'text/plain',
          body: { data: Buffer.from('Apps due Aug 28').toString('base64url') },
        },
        { mimeType: 'image/png', filename: 'flyer.png', body: { attachmentId: 'a1' } },
      ],
    },
  };
  const s = await g.toSource('org', msg);
  assert.match(s.rawText, /Apps due/);
  assert.equal(s.media[0]?.base64, Buffer.from('png').toString('base64'));
});
test('Gmail sync requires persisted history cursor', async () => {
  const st = new Store();
  await assert.rejects(
    () => new GmailConnector('x').sync(st, () => undefined),
    /No Gmail history cursor/,
  );
  await st.close();
});

test('Instagram business discovery parses carousel images', async () => {
  const http: any = async () =>
    jsonResponse({
      business_discovery: {
        username: 'unc180dc',
        website: 'https://x.com',
        media: {
          data: [
            {
              id: 'p1',
              caption: 'Apply now',
              media_type: 'CAROUSEL_ALBUM',
              permalink: 'https://instagram.com/p/p1',
              timestamp: '2026-08-27T00:00:00Z',
              children: {
                data: [
                  { media_type: 'IMAGE', media_url: 'https://img/1.jpg' },
                  { media_type: 'IMAGE', media_url: 'https://img/2.jpg' },
                ],
              },
            },
          ],
        },
      },
    });
  const x = await new InstagramConnector('tok', 'me', 'v24.0', http).sourcesForOrganization(
    'org',
    '@unc180dc',
  );
  assert.equal(x.sources[0]?.media.length, 2);
  assert.equal(x.profile.website, 'https://x.com');
});
test('Instagram handle normalization', async () => {
  let url = '';
  const http: any = async (input: any) => {
    url = String(input);
    return jsonResponse({ business_discovery: { media: { data: [] } } });
  };
  await new InstagramConnector('t', 'me', 'v24.0', http).businessDiscovery('@UNC180DC');
  assert.match(decodeURIComponent(url), /username\(unc180dc\)/);
});

test('LinkedIn vanity extraction', () =>
  assert.equal(
    linkedinVanityName('https://www.linkedin.com/company/180-degrees-consulting-unc/'),
    '180-degrees-consulting-unc',
  ));
test('LinkedIn vanity resolution', async () => {
  const http: any = async () => jsonResponse({ elements: [{ id: 123 }] });
  assert.equal(
    await new LinkedInConnector('t', '202608', http).resolveOrganizationUrn(
      'https://linkedin.com/company/foo',
    ),
    'urn:li:organization:123',
  );
});
test('LinkedIn post hydrates image', async () => {
  const http: any = async (input: any) =>
    String(input).includes('/images/')
      ? jsonResponse({ downloadUrl: 'https://img/li.jpg' })
      : jsonResponse({
          elements: [
            {
              id: 'urn:li:share:1',
              author: 'urn:li:organization:1',
              commentary: 'Apps open',
              publishedAt: 1,
              content: { media: { id: 'urn:li:image:1' } },
            },
          ],
        });
  const x = await new LinkedInConnector('t', '202608', http).posts('org', 'urn:li:organization:1');
  assert.equal(x[0]?.media[0]?.url, 'https://img/li.jpg');
});

test('Web connector extracts links and visible text', async () => {
  const http: any = async () =>
    new Response(
      '<title>Recruit</title><a href="https://forms.gle/abc">Apply</a><p>Apps open</p>',
      { status: 200, headers: { 'content-type': 'text/html' } },
    );
  const web = new WebConnector(http, async (u) => new URL(u));
  const x = await web.fetchSource('org', 'https://club.example/recruit');
  assert.equal(x.links[0], 'https://forms.gle/abc');
  assert.match(x.source.rawText, /Apps open/);
});
test('Web connector classifies form as application', async () => {
  const http: any = async () =>
    new Response('no longer accepting responses', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
  const web = new WebConnector(http, async (u) => new URL(u));
  assert.equal(
    (await web.fetchSource('org', 'https://forms.gle/abc')).source.sourceType,
    'application',
  );
});
