const REPO = 'iwaicollective-bot/yoshino-channel-dashboard';
const COOLDOWN_MS = 10 * 60 * 1000; // 10分クールダウン

const lastRunMap = new Map();

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

export async function onRequestPost(context) {
  const { env } = context;
  const ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
  const GH_TOKEN = env.GH_TOKEN;

  // クールダウンチェック
  const now = Date.now();
  const lastRun = lastRunMap.get('refresh') || 0;
  if (now - lastRun < COOLDOWN_MS) {
    const wait = Math.ceil((COOLDOWN_MS - (now - lastRun)) / 60000);
    return new Response(JSON.stringify({ error: 'rate_limited', message: `あと${wait}分待ってください` }), {
      status: 429, headers: { 'Content-Type': 'application/json' }
    });
  }

  if (!ANTHROPIC_API_KEY || !GH_TOKEN) {
    return new Response(JSON.stringify({ error: 'env_vars_missing', message: 'ANTHROPIC_API_KEY と GH_TOKEN を Cloudflare の環境変数に設定してください' }), {
      status: 503, headers: { 'Content-Type': 'application/json' }
    });
  }

  lastRunMap.set('refresh', now);

  try {
    // 既存記事取得
    const { text: artText, sha: artSha } = await ghGet('articles.json', GH_TOKEN);
    const { text: htmlText, sha: htmlSha } = await ghGet('index.html', GH_TOKEN);
    const { text: metaText, sha: metaSha } = await ghGet('meta.json', GH_TOKEN);

    const existingArticles = JSON.parse(artText);
    const meta = JSON.parse(metaText);
    const maxId = existingArticles.reduce((m, a) => {
      const n = parseInt((a.id || '').replace('art', ''), 10);
      return isNaN(n) ? m : Math.max(m, n);
    }, 0);

    // Claude APIで新記事生成
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: `吉野敏明チャンネル（歯科医師・漢方家系11代目・銀座エルディアクリニック院長）のテーマ出しダッシュボード用に、健康・食・東洋医学に関する新しい記事を1本生成してください。

既存記事ID最大値: art${String(maxId).padStart(3,'0')}

以下のJSON形式で出力（JSON以外は出力しないこと）:
{
  "id": "art${String(maxId+1).padStart(3,'0')}",
  "title": "インパクトのある日本語タイトル",
  "badge": "red" または "yellow" または "green",
  "badgeLabel": "日本未報道" または "日本と海外で乖離" または "重要背景情報",
  "category": "食・栄養" または "食品添加物" または "農薬・食の安全" または "東洋医学" または "医療政策",
  "date": "${new Date().toISOString().slice(0,10)}",
  "summary": "200字以内の客観的な概要",
  "yoshinoReading": "吉野敏明（歯科医・漢方家系11代目）視点での読み解き。断定的な医療効果の表現は避け、「〜との関連が報告されている」等エビデンスベースの表現を使う",
  "primarySources": [{"title": "実在する資料名", "url": "https://実在するURL"}],
  "japanSources": [{"media": "メディア名", "title": "記事タイトル", "url": "https://実在するURL"}],
  "credibilityScore": 3,
  "tags": ["タグ1", "タグ2", "タグ3"]
}

重要: 医師法に違反しない表現。架空のURLは使わない。`
        }]
      })
    });

    const claudeData = await claudeRes.json();
    const newArticle = JSON.parse(claudeData.content[0].text.trim());

    const updatedArticles = [...existingArticles, newArticle];
    const updatedMeta = { ...meta, lastUpdated: new Date().toISOString(), articleCount: updatedArticles.length };

    // index.html内のEMBEDDED_ARTICLES更新
    const articlesInline = JSON.stringify(updatedArticles, null, 0);
    const updatedHtml = htmlText.replace(
      /const EMBEDDED_ARTICLES = \[.*?\];/s,
      `const EMBEDDED_ARTICLES = ${articlesInline};`
    );

    const today = new Date().toISOString().slice(0,10);
    const msg = `auto: 題材更新 ${today} (+1件)`;

    await ghPut('articles.json', JSON.stringify(updatedArticles, null, 2), artSha, msg, GH_TOKEN);
    await ghPut('index.html', updatedHtml, htmlSha, msg, GH_TOKEN);
    await ghPut('meta.json', JSON.stringify(updatedMeta, null, 2), metaSha, msg, GH_TOKEN);

    return new Response(JSON.stringify({ status: 'ok', articles: updatedArticles, newArticle }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}
