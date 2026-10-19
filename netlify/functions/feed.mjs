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
const HEADERS = { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=10' };

export default async (req) => {
  const url = new URL(req.url);
  const accounts = (process.env.X_ACCOUNTS || url.searchParams.get('accounts') || 'WatcherGuru,DeItaone,unusual_whales')
    .split(',').map(s => s.trim().replace(/^@/, '')).filter(s => /^\w{1,15}$/.test(s)).slice(0, 20);
  const query = `(${accounts.map(a => 'from:' + a).join(' OR ')}) -is:retweet -is:reply`;

  // serve the same answer for 12s so X's rate limits are never hit
  if (cache.key === query && Date.now() - cache.at < 12000) return new Response(cache.body, { headers: HEADERS });

  try {
    let posts = [];
    if (process.env.TWITTERAPI_IO_KEY) posts = await viaTwitterApiIo(query);
    else if (process.env.X_BEARER_TOKEN) posts = await viaX(query);
    posts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    cache = { key: query, at: Date.now(), body: JSON.stringify(posts.slice(0, 50)) };
  } catch (e) {
    // keep serving the last good answer
  }
  return new Response(cache.body, { headers: HEADERS });
};

async function viaTwitterApiIo(query) {
  const u = new URL('https://api.twitterapi.io/twitter/tweet/advanced_search');
  u.searchParams.set('query', query);
  u.searchParams.set('queryType', 'Latest');
  const r = await fetch(u, { headers: { 'X-API-Key': process.env.TWITTERAPI_IO_KEY } });
  if (!r.ok) throw new Error('twitterapi.io ' + r.status);
  const j = await r.json();
  return (j.tweets || []).map(t => {
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
  if (!r.ok) throw new Error('x ' + r.status);
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
      media: m ? (m.media_url_https || m.url || m.preview_image_url || null) : null,
    };
  });
}
