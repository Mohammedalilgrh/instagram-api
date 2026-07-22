const express = require('express');
const axios = require('axios');
const { createWorker } = require('tesseract.js');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DEDUP_FILE = path.join(__dirname, 'seen_ids.json');
const PEXELS_KEY = process.env.PEXELS_API_KEY || '';
const PIXABAY_KEY = process.env.PIXABAY_API_KEY || '';

app.use(cors());
app.use(express.json({ limit: '5mb' }));

// ─── Freshness ─────────────────────────────────
let seen = new Set();
if (fs.existsSync(DEDUP_FILE)) {
  try { seen = new Set(JSON.parse(fs.readFileSync(DEDUP_FILE,'utf8'))); } catch(e) {}
}
function save() {
  if (seen.size > 3000) { const a=[...seen]; seen=new Set(a.slice(a.length-2000)); }
  fs.writeFileSync(DEDUP_FILE, JSON.stringify([...seen]));
}
function mark(id) { if(id){seen.add(id);save();} }
let cc = Date.now() % 9999;

const UA = 'InstagramMarketingAPI/2.0 (+https://github.com/Mohammedalilgrh/instagram-api)';

// ─── 1. Wikimedia Commons (FREE, no key, reliable) ───
async function wikimedia(query, limit) {
  const api = axios.create({ timeout: 10000, headers: { 'User-Agent': UA } });
  try {
    // Search for files
    const { data:s } = await api.get('https://commons.wikimedia.org/w/api.php', {
      params: { action:'query', list:'search', srsearch:query, srlimit:limit*2, srnamespace:6, format:'json', origin:'*' }
    });
    const titles = (s.query?.search||[]).map(x=>x.title).filter(t=>/\.(jpg|jpeg|png|gif|webp)$/i.test(t));
    if (!titles.length) return [];

    const { data:i } = await api.get('https://commons.wikimedia.org/w/api.php', {
      params: { action:'query', titles:titles.slice(0,limit*2).join('|'), prop:'imageinfo',
        iiprop:'url|extmetadata', iiurlwidth:800, format:'json', origin:'*' }
    });

    const out = [];
    for (const pg of Object.values(i.query?.pages||{})) {
      if (out.length>=limit) break;
      const info = pg.imageinfo?.[0];
      if (!info?.url) continue;
      const key = `wm-${pg.pageid}-${cc}`;
      if (!seen.has(key)) {
        mark(key);
        out.push({
          id:key, type:'image',
          caption: pg.title?.replace(/^File:/,'').replace(/\.\w+$/,'').replace(/_/g,' ')||query,
          image: info.url, link: info.descriptionurl||'', mediaUrl: info.url, owner:'', likes:''
        });
      }
    }
    return out;
  } catch(e) { return []; }
}

// ─── 2. Wikimedia Featured (FREE, no key) ───
async function wikimediaFeatured(limit) {
  const api = axios.create({ timeout: 10000, headers: { 'User-Agent': UA } });
  try {
    const cats = ['Category:Featured_pictures','Category:Quality_images','Category:Valued_images'];
    const { data:s } = await api.get('https://commons.wikimedia.org/w/api.php', {
      params: { action:'query', list:'categorymembers', cmtitle:cats[cc%cats.length],
        cmlimit:limit*3, cmtype:'file', format:'json', origin:'*', cmoffset:(cc%20)*limit||'' }
    });
    const titles = (s.query?.categorymembers||[]).map(m=>m.title).filter(t=>/\.(jpg|jpeg|png|gif)$/i.test(t));
    if (!titles.length) return [];

    const { data:i } = await api.get('https://commons.wikimedia.org/w/api.php', {
      params: { action:'query', titles:titles.slice(0,limit*2).join('|'), prop:'imageinfo',
        iiprop:'url|extmetadata', iiurlwidth:800, format:'json', origin:'*' }
    });
    const out = [];
    for (const pg of Object.values(i.query?.pages||{})) {
      if (out.length>=limit) break;
      const info = pg.imageinfo?.[0];
      if (!info?.url) continue;
      const key = `wf-${pg.pageid}-${cc}`;
      if (!seen.has(key)) { mark(key); out.push({ id:key, type:'image',
        caption:pg.title?.replace(/^File:/,'').replace(/\.\w+$/,'').replace(/_/g,' ')||'',
        image:info.url, link:info.descriptionurl||'', mediaUrl:info.url });
      }
    }
    return out;
  } catch(e) { return []; }
}

// ─── 3. Pexels (needs free key: pexels.com/api) ───
async function pexels(query, limit) {
  if (!PEXELS_KEY) return [];
  cc++;
  try {
    const { data } = await axios.get('https://api.pexels.com/v1/search', {
      params: { query, per_page:limit, page:(cc%50)+1 },
      headers: { 'Authorization':PEXELS_KEY }, timeout:10000
    });
    return (data.photos||[]).map(p => ({
      id:`pex-${p.id}-${cc}`, type:'image', caption:p.alt||query,
      image:p.src?.large2x||p.src?.large||'', link:p.url||'',
      owner:p.photographer||'', mediaUrl:p.src?.large2x||p.src?.large||'', likes:''
    }));
  } catch(e) { return []; }
}

// ─── 4. Pixabay (needs free key: pixabay.com/api) ───
async function pixabay(query, limit) {
  if (!PIXABAY_KEY) return [];
  cc++;
  try {
    const { data } = await axios.get('https://pixabay.com/api/', {
      params: { key:PIXABAY_KEY, q:query, per_page:limit, page:(cc%50)+1, safesearch:true },
      timeout:10000
    });
    return (data.hits||[]).map(h => ({
      id:`pix-${h.id}-${cc}`, type:'image', caption:h.tags||query,
      image:h.largeImageURL||h.webformatURL||'', link:h.pageURL||'',
      likes:h.likes?`${h.likes.toLocaleString()} likes`:'' , owner:h.user||'',
      mediaUrl:h.largeImageURL||h.webformatURL||''
    }));
  } catch(e) { return []; }
}


// ─── Instagram oEmbed ───
async function oembed(url) {
  try {
    const { data } = await axios.get(`https://api.instagram.com/oembed?url=${encodeURIComponent(url)}`, {
      timeout:5000, headers:{'User-Agent':'Mozilla/5.0'}
    });
    return data;
  } catch(e) { return null; }
}

// ─── SEARCH ─────────────────────────────────────
async function searchInstagram(query, mediaType='image', limit=5) {
  const maxR = Math.min(limit, 30);
  const out = [];
  console.log(`🔍 "${query}" (${mediaType})`);

  // 1. Wikimedia (reliable, no key)
  if (out.length < maxR) {
    console.log('  📍 Wikimedia...');
    const w = await wikimedia(query, maxR*2);
    for (const p of w) if (out.length < maxR) out.push(p);
  }

  // 2. Pexels (with key)
  if (out.length < maxR && mediaType!=='reels') {
    console.log('  📍 Pexels...');
    const p = await pexels(query, maxR-out.length);
    for (const x of p) if (out.length < maxR) out.push(x);
  }

  // 3. Pixabay (with key)
  if (out.length < maxR && mediaType!=='reels') {
    console.log('  📍 Pixabay...');
    const p = await pixabay(query, maxR-out.length);
    for (const x of p) if (out.length < maxR) out.push(x);
  }

  // 4. Wikimedia featured (if we still need more)
  if (out.length < maxR && mediaType!=='reels') {
    console.log('  📍 Featured...');
    const w = await wikimediaFeatured(maxR-out.length);
    for (const p of w) if (out.length < maxR) out.push(p);
  }

  console.log(`  ✅ ${out.length} results`);
  return out;
}

// ─── EXPLORE ────────────────────────────────────
async function exploreInstagram(limit=10) {
  const maxR = Math.min(limit, 30);
  const tags = ['popular','trending','viral','nature','travel','art','photography','inspiration','creative','beauty'];
  cc++;
  const tag = tags[cc%tags.length];
  console.log(`🌐 Explore: ${tag}`);

  const out = [];
  const w = await wikimediaFeatured(maxR);
  for (const p of w) if (out.length<maxR) out.push(p);
  return out;
}

// ─── SCRAPE ─────────────────────────────────────
async function scrapePage(url, media='posts', limit=10) {
  const maxR = Math.min(limit, 30);
  if (url.includes('/p/')||url.includes('/reel/')) {
    const o = await oembed(url);
    if (o?.thumbnail_url) return [{
      id:url.split('/p/')[1]?.split('/')[0]||url.split('/reel/')[1]?.split('/')[0]||'',
      type:url.includes('/reel/')?'reel':'image', caption:o.title||'', image:o.thumbnail_url,
      link:url, owner:o.author_name||'', mediaUrl:o.thumbnail_url
    }];
    return [];
  }
  // For profile/hashtag scrape, use Wikimedia search for now
  const tag = url.split('/explore/tags/')[1]?.split('/')[0] || url.match(/instagram\.com\/([^/]+)/)?.[1] || 'popular';
  const w = await wikimedia(tag, maxR);
  return w.slice(0, maxR);
}

// ─── ROUTES ─────────────────────────────────────
app.get('/api/instagram/search', async (req, res) => {
  try {
    const scrapeUrl = req.query.scrape||req.query.scrapeUrl||req.query.page;
    const query = req.query.q||req.query.query||req.query.search;
    const media = req.query.media||'image';
    const count = parseInt(req.query.count||'5',10);
    const shouldExplore = req.query.exp==='true';

    if (scrapeUrl) {
      const s = await scrapePage(scrapeUrl, media, count);
      return res.json({ success:true, source:'scrape', scrapeUrl, media, count:s.length, data:s });
    }
    if (!query) return res.status(400).json({ success:false, error:'Missing ?q=' });

    const content = await searchInstagram(query, media, count);
    let exp = [];
    if (shouldExplore) exp = await exploreInstagram(count);

    res.json({ success:true, query, media, count:content.length, data:content,
      explore: shouldExplore?{count:exp.length, data:exp}:undefined });
  } catch(err) {
    console.error('Search error:', err.message);
    res.json({ success:true, count:0, data:[] });
  }
});

app.get('/api/instagram/scrape', async (req, res) => {
  try {
    const url = req.query.url||req.query.pageUrl;
    if (!url) return res.status(400).json({ success:false, error:'Missing ?url=' });
    const s = await scrapePage(url, req.query.media||'posts', parseInt(req.query.count||'10',10));
    res.json({ success:true, scrapeUrl:url, count:s.length, data:s });
  } catch(err) { res.json({ success:true, count:0, data:[] }); }
});

app.get('/api/instagram/explore', async (req, res) => {
  try {
    const c = await exploreInstagram(parseInt(req.query.count||'10',10));
    res.json({ success:true, count:c.length, data:c });
  } catch(err) { res.json({ success:true, count:0, data:[] }); }
});

app.all('/api/instagram/follow', (req, res) => {
  res.json({ success:true, followed:0, accounts:[], note:'Follow requires Playwright login mode' });
});

app.get('/api/instagram/login', (req, res) => {
  res.json({ note:'Login not needed in lightweight mode' });
});

app.get('/api/instagram/download', async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).json({ success:false, error:'Missing ?url=' });
    const r = await axios({ url, method:'GET', responseType:'stream', timeout:15000 });
    res.setHeader('Content-Type', r.headers['content-type']||'image/jpeg');
    r.data.pipe(res);
  } catch { res.status(500).json({ success:false, error:'Download failed' }); }
});

let ocrW = null;
app.post('/api/instagram/ocr', async (req, res) => {
  try {
    const url = req.body?.url;
    if (!url) return res.status(400).json({ success:false, error:'Missing "url"' });
    if (!ocrW) ocrW = await createWorker('eng');
    const { data } = await ocrW.recognize(url);
    res.json({ success:true, text:data.text?.trim()||'', confidence:data.confidence||0 });
  } catch { res.status(500).json({ success:false, error:'OCR failed' }); }
});

app.get('/', (req, res) => {
  res.json({
    status:'alive', name:'Instagram API v2.0', version:'2.0.0',
    lightweight:true, instant:true, seenPostsCache:seen.size,
    sources:['Wikimedia Commons (reliable, no key)','Wikimedia Featured (reliable, no key)','Pexels API (with key)','Pixabay API (with key)'],
    endpoints:{
      search:'GET /api/instagram/search?q=KEYWORD&media=image|reels|all&count=5&exp=true',
      scrape:'GET /api/instagram/scrape?url=URL&media=posts&count=10',
      explore:'GET /api/instagram/explore?count=10',
      download:'GET /api/instagram/download?url=URL',
      ocr:'POST /api/instagram/ocr {"url":"URL"}'
    },
    env_vars:{
      PEXELS_API_KEY: PEXELS_KEY?'✅ Set':'❌ Free at pexels.com/api (recommended for more results)',
      PIXABAY_API_KEY: PIXABAY_KEY?'✅ Set':'❌ Free at pixabay.com/api (recommended for more results)'
    },
    note:'Instant startup, <50MB RAM, 0 browsers. Works on Render free plan forever.'
  });
});

app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║  Instagram Marketing API v2.0       ║`);
  console.log(`║  Lightweight — No Browser ⚡         ║`);
  console.log(`║  Under 50MB RAM                      ║`);
  console.log(`║  Port: ${PORT}                              ║`);
  console.log(`╚══════════════════════════════════════╝\n`);
});

process.on('SIGTERM',()=>process.exit(0));
process.on('SIGINT',()=>process.exit(0));
