const REPO = 'iwaicollective-bot/yoshino-channel-dashboard';

function b64Decode(b64) {
  const binary = atob(b64.replace(/\n/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

function b64Encode(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  bytes.forEach(b => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

async function ghGet(path, token) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}?ref=main`, {
    headers: {
      Authorization: `token ${token}`,
      'User-Agent': 'yoshino-dashboard-bot',
      Accept: 'application/vnd.github.v3+json',
    },
  });
  const data = await res.json();
  if (!data.content) throw new Error(`ghGet failed: ${path}`);
  return { text: b64Decode(data.content), sha: data.sha };
}

async function ghPut(path, content, sha, message, token) {
  const encoded = b64Encode(typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    method: 'PUT',
    headers: {
      Authorization: `token ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'yoshino-dashboard-bot',
      Accept: 'application/vnd.github.v3+json',
    },
    body: JSON.stringify({
      message,
      content: encoded,
      sha,
      branch: 'main',
      committer: { name: 'Yoshino Dashboard Bot', email: 'bot@iwaicollective.com' },
    }),
  });
  const result = await res.json();
  if (!result.content) throw new Error(`ghPut failed: ${path}`);
  return result.content.sha;
}

async function handleDelete(request, env) {
  const GH_TOKEN = env.GH_TOKEN;
  if (!GH_TOKEN) {
    return new Response(JSON.stringify({ error: 'GH_TOKEN not set' }), {
      status: 503, headers: { 'Content-Type': 'application/json' }
    });
  }

  let id;
  try {
    const body = await request.json();
    id = body.id;
  } catch {
    return new Response(JSON.stringify({ error: 'invalid JSON' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  if (!id) {
    return new Response(JSON.stringify({ error: 'id required' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const { text: artText, sha: artSha } = await ghGet('articles.json', GH_TOKEN);
    const { text: htmlText, sha: htmlSha } = await ghGet('index.html', GH_TOKEN);

    const existingArticles = JSON.parse(artText);
    const updatedArticles = existingArticles.filter(a => a.id !== id);

    if (updatedArticles.length === existingArticles.length) {
      return new Response(JSON.stringify({ error: 'not_found', message: '記事が見つかりません' }), {
        status: 404, headers: { 'Content-Type': 'application/json' }
      });
    }

    const articlesInline = JSON.stringify(updatedArticles, null, 0);
    const updatedHtml = htmlText.replace(
      /const EMBEDDED_ARTICLES = \[.*?\];/s,
      `const EMBEDDED_ARTICLES = ${articlesInline};`
    );

    const today = new Date().toISOString().slice(0, 10);
    const msg = `delete: 記事削除 ${id} (${today})`;
    await ghPut('articles.json', JSON.stringify(updatedArticles, null, 2), artSha, msg, GH_TOKEN);
    await ghPut('index.html', updatedHtml, htmlSha, msg, GH_TOKEN);

    return new Response(JSON.stringify({ status: 'ok', deletedId: id }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/worker-entry.js' || url.pathname === '/wrangler.toml') {
      return new Response('Not Found', { status: 404 });
    }

    if (url.pathname === '/api/delete' && request.method === 'POST') {
      return handleDelete(request, env);
    }

    return env.ASSETS.fetch(request);
  }
};
