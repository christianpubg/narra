// Narrative — live X tracker for the home page.
// Returns the latest posts from the news pages listed in NARRATIVE_CONFIG.accounts.
//
// 1) Put this file in your repo at netlify/functions/feed.mjs
// 2) In index.html set:  feed: "/.netlify/functions/feed"
// 3) In Netlify > Site settings > Environment variables, add ONE of:
//      TWITTERAPI_IO_KEY  - key from twitterapi.io (third-party X data, pay per use)
//      X_BEARER_TOKEN     - bearer token from the official X API (paid plan needed for search)
//
// Optional: X_ACCOUNTS = comma list of handles, overrides the list the site sends.

let cache = { key: '', at: 0, body: '[]' };
let history = { key: '', posts: [] }; // keeps older posts so the feed has history
const HEADERS = { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=10' };

export default async (req) => {
  const url = new URL(req.url);
  const accounts = (process.env.X_ACCOUNTS || url.searchParams.get('accounts') || 'WatcherGuru,DeItaone,unusual_whales')
    .split(',').map(s => s.trim().replace(/^@/, '')).filter(s => /^\w{1,15}$/.test(s)).slice(0, 20);
  const query = `(${accounts.map(a => 'from:' + a).join(' OR ')}) -is:retweet -is:reply`;

  const debug = url.searchParams.has('debug');

  // serve the same answer for 12s so the API isn't hit on every visit
  if (!debug && cache.key === query && Date.now() - cache.at < 12000) return new Response(cache.body, { headers: HEADERS });

  try {
    let posts = [];
    const cold = history.key !== query || !history.posts.length;
    if (process.env.TWITTERAPI_IO_KEY) posts = await viaTwitterApiIo(query, cold ? 3 : 1);
    else if (process.env.X_BEARER_TOKEN) posts = await viaX(query);
    else throw new Error('No key found. Add TWITTERAPI_IO_KEY in Netlify environment variables, then redeploy.');
    // merge new posts into the history we already have
    const prev = history.key === query ? history.posts : [];
    const seen = new Set(posts.map(p => p.id));
    posts = posts.concat(prev.filter(p => !seen.has(p.id)));
    posts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    posts = posts.slice(0, 80);
    history = { key: query, posts };
    cache = { key: query, at: Date.now(), body: JSON.stringify(posts) };
    if (debug) return new Response(JSON.stringify({ ok: true, posts: posts.length, query }, null, 2), { headers: HEADERS });
  } catch (e) {
    if (debug) return new Response(JSON.stringify({ ok: false, error: String(e.message || e), query }, null, 2), { headers: HEADERS });
  }
  return new Response(cache.body, { headers: HEADERS });
};

async function viaTwitterApiIo(query, pages) {
  let all = [], cursor = '';
  for (let page = 0; page < pages; page++) {
    const u = new URL('https://api.twitterapi.io/twitter/tweet/advanced_search');
    u.searchParams.set('query', query);
    u.searchParams.set('queryType', 'Latest');
    if (cursor) u.searchParams.set('cursor', cursor);
    const r = await fetch(u, { headers: { 'X-API-Key': process.env.TWITTERAPI_IO_KEY } });
    const txt = await r.text();
    if (!r.ok) throw new Error('twitterapi.io said ' + r.status + ': ' + txt.slice(0, 300));
    const j = JSON.parse(txt);
    const got = j.tweets || [];
    const before = all.length;
    for (const t of got) if (!all.some(x => x.id === t.id)) all.push(t);
    if (!j.has_next_page || !j.next_cursor || all.length === before) break;
    cursor = j.next_cursor;
  }
  return all.map(t => {
    const m = t.extendedEntities?.media?.[0] || t.entities?.media?.[0];
    return {
      id: String(t.id),
      text: t.text,
      createdAt: new Date(t.createdAt).toISOString(),
      author: { name: t.author?.name, username: t.author?.userName, avatar: (t.author?.profilePicture || '').replace('_normal', '_bigger') },
      media: m ? (m.media_url_https || m.url || null) : null,
    };
  });
}

async function viaX(query) {
  const u = new URL('https://api.x.com/2/tweets/search/recent');
  u.searchParams.set('query', query);
  u.searchParams.set('max_results', '50');
  u.searchParams.set('tweet.fields', 'created_at,attachments,author_id');
  u.searchParams.set('expansions', 'author_id,attachments.media_keys');
  u.searchParams.set('user.fields', 'name,username,profile_image_url');
  u.searchParams.set('media.fields', 'url,preview_image_url,type');
  const r = await fetch(u, { headers: { authorization: `Bearer ${process.env.X_BEARER_TOKEN}` } });
  if (!r.ok) throw new Error('X API said ' + r.status + ': ' + (await r.text()).slice(0, 300));
  const j = await r.json();
  const users = Object.fromEntries((j.includes?.users || []).map(x => [x.id, x]));
  const media = Object.fromEntries((j.includes?.media || []).map(x => [x.media_key, x]));
  return (j.data || []).map(t => {
    const usr = users[t.author_id] || {}, m = media[t.attachments?.media_keys?.[0]];
    return {
      id: t.id,
      text: t.text,
      createdAt: t.created_at,
      author: { name: usr.name, username: usr.username, avatar: (usr.profile_image_url || '').replace('_normal', '_bigger') },
      media: m ? (m.url || m.preview_image_url || null) : null,
    };
  });
}
