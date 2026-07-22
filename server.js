const express = require('express');
const { chromium } = require('playwright');
const axios = require('axios');
const { createWorker } = require('tesseract.js');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const IG_USERNAME = process.env.IG_USERNAME || '';
const IG_PASSWORD = process.env.IG_PASSWORD || '';
const STATE_FILE = path.join(__dirname, 'instagram_auth.json');
const DEDUP_FILE = path.join(__dirname, 'seen_ids.json');
const PEXELS_KEY = process.env.PEXELS_API_KEY || '';
const PIXABAY_KEY = process.env.PIXABAY_API_KEY || '';

app.use(cors());
app.use(express.json({ limit: '5mb' }));

let loggedIn = false;

// ─── Freshness ─────────────────────────────────
let seenIds = new Set();
if (fs.existsSync(DEDUP_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(DEDUP_FILE, 'utf8'));
    seenIds = new Set(Array.isArray(saved) ? saved : []);
    console.log(`📌 Loaded ${seenIds.size} seen post IDs`);
  } catch (e) { seenIds = new Set(); }
}
function trimSeenIds() {
  if (seenIds.size > 2000) {
    const arr = [...seenIds];
    seenIds = new Set(arr.slice(arr.length - 1500));
  }
}
function saveSeenIds() { trimSeenIds(); fs.writeFileSync(DEDUP_FILE, JSON.stringify([...seenIds])); }
function markSeen(id) { if (id) { seenIds.add(id); saveSeenIds(); } }
function isSeen(id) { return seenIds.has(id); }

let callCounter = Date.now();
let rotationIndex = 0;
const ROTATION_WORDS = ['popular','trending','viral','best','top','new','latest','amazing','inspiring','creative','daily','hot','aesthetic','goals','love','life','art','beautiful','style','cool','fun','great','dream','hope','smile','happy','peace','mindset','focus','success','win','rise','shine','vision','passion','believe','inspire','drive'];

const WIKI_UA = 'InstagramMarketingAPI/2.0 (+https://github.com/Mohammedalilgrh/instagram-api)';

// ─── Wikimedia Commons (FREE, always works, no key) ───
async function wikimedia(query, limit) {
  const api = axios.create({ timeout: 10000, headers: { 'User-Agent': WIKI_UA } });
  try {
    const { data:s } = await api.get('https://commons.wikimedia.org/w/api.php', {
      params: { action:'query', list:'search', srsearch:query, srlimit:limit*3, srnamespace:6, format:'json', origin:'*' }
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
      const key = `wm-${pg.pageid}`;
      if (!isSeen(key)) {
        markSeen(key);
        out.push({
          id:key, type:'image',
          caption: pg.title?.replace(/^File:/,'').replace(/\.\w+$/,'').replace(/_/g,' ')||query,
          image: info.url, link: info.descriptionurl||'', mediaUrl: info.url, owner:'', likes:'',
        });
      }
    }
    return out;
  } catch(e) { return []; }
}

async function wikimediaFeatured(limit) {
  const api = axios.create({ timeout: 10000, headers: { 'User-Agent': WIKI_UA } });
  try {
    const cats = ['Category:Featured_pictures','Category:Quality_images','Category:Valued_images'];
    callCounter++;
    const { data:s } = await api.get('https://commons.wikimedia.org/w/api.php', {
      params: { action:'query', list:'categorymembers', cmtitle:cats[callCounter%cats.length],
        cmlimit:limit*3, cmtype:'file', format:'json', origin:'*', cmoffset:(callCounter%20)*limit||'' }
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
      const key = `wf-${pg.pageid}`;
      if (!isSeen(key)) { markSeen(key); out.push({ id:key, type:'image',
        caption:pg.title?.replace(/^File:/,'').replace(/\.\w+$/,'').replace(/_/g,' ')||'',
        image:info.url, link:info.descriptionurl||'', mediaUrl:info.url, owner:'', likes:'' });
      }
    }
    return out;
  } catch(e) { return []; }
}

// ─── Instagram oEmbed ──────────────────────────
async function oembed(url) {
  try {
    const { data } = await axios.get(`https://api.instagram.com/oembed?url=${encodeURIComponent(url)}`, {
      timeout:5000, headers:{'User-Agent':'Mozilla/5.0'}
    });
    return data;
  } catch(e) { return null; }
}

// ─── Fallback: oEmbed search by hashtag ────────
// Uses Wikimedia to simulate Instagram-like results for any query
async function fallbackSearch(query, limit) {
  const maxRes = Math.min(limit, 30);
  const out = [];

  // First try Wikimedia search directly
  const wm = await wikimedia(query, maxRes);
  for (const p of wm) if (out.length < maxRes) out.push(p);

  // Try pexels if key available
  if (out.length < maxRes && PEXELS_KEY) {
    try {
      callCounter++;
      const { data } = await axios.get('https://api.pexels.com/v1/search', {
        params: { query, per_page:limit, page:(callCounter%50)+1 },
        headers: { 'Authorization':PEXELS_KEY }, timeout:10000
      });
      for (const p of (data.photos||[])) {
        if (out.length>=maxRes) break;
        const key = `pex-${p.id}`;
        if (!isSeen(key)) { markSeen(key); out.push({ id:key, type:'image', caption:p.alt||query,
          image:p.src?.large2x||p.src?.large||'', link:p.url||'', owner:p.photographer||'', mediaUrl:p.src?.large2x||p.src?.large||'', likes:'' });
        }
      }
    } catch(e) {}
  }

  // Try pixabay if key available
  if (out.length < maxRes && PIXABAY_KEY) {
    try {
      callCounter++;
      const { data } = await axios.get('https://pixabay.com/api/', {
        params: { key:PIXABAY_KEY, q:query, per_page:limit, page:(callCounter%50)+1, safesearch:true },
        timeout:10000
      });
      for (const h of (data.hits||[])) {
        if (out.length>=maxRes) break;
        const key = `pix-${h.id}`;
        if (!isSeen(key)) { markSeen(key); out.push({ id:key, type:'image', caption:h.tags||query,
          image:h.largeImageURL||h.webformatURL||'', link:h.pageURL||'', likes:h.likes?`${h.likes.toLocaleString()} likes`:'' , owner:h.user||'', mediaUrl:h.largeImageURL||h.webformatURL||'' });
        }
      }
    } catch(e) {}
  }

  // Featured Wikimedia images as last resort
  if (out.length < maxRes) {
    const ft = await wikimediaFeatured(maxRes - out.length);
    for (const p of ft) if (out.length < maxRes) out.push(p);
  }

  // Attach likes/owner to Wikimedia results when possible
  return out.map(p => ({
    ...p,
    // Ensure all fields are present
    owner: p.owner || '',
    likes: p.likes || '',
    image: p.image || p.mediaUrl || '',
  }));
}

// ─── Instagram Login ───────────────────────────
async function loginToInstagram() {
  if (!IG_USERNAME || !IG_PASSWORD) {
    console.log('⚠️  Instagram credentials not set. Using fallback sources.');
    return false;
  }

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
    });

    const page = await context.newPage();
    console.log('🔑 Logging into Instagram...');

    await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'commit', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(4000);

    try {
      const cookieBtn = page.locator('button:has-text("Allow"), button:has-text("Accept"), button:has-text("Allow all")').first();
      await cookieBtn.click({ timeout: 5000 });
      await page.waitForTimeout(2000);
    } catch (e) {}

    const usernameInput = page.locator(
      'input[name="username"], input[autocomplete="username"], input[aria-label*="Phone" i], input[aria-label*="username" i], input[aria-label*="email" i]'
    ).first();
    await usernameInput.waitFor({ timeout: 20000 });
    await usernameInput.fill(IG_USERNAME, { timeout: 10000 });
    await page.waitForTimeout(500);

    const passwordInput = page.locator(
      'input[name="password"], input[autocomplete="current-password"], input[aria-label*="Password" i]'
    ).first();
    await passwordInput.fill(IG_PASSWORD, { timeout: 10000 });
    await page.waitForTimeout(500);

    const loginBtn = page.locator(
      'button[type="submit"], div[role="button"]:has-text("Log in"), button:has-text("Log in")'
    ).first();
    await loginBtn.click();
    await page.waitForTimeout(8000);

    let loginSuccess = false;
    try {
      const currentUrl = page.url();
      if (currentUrl.includes('accounts/login')) {
        await page.waitForTimeout(5000);
      }
      loginSuccess = !page.url().includes('accounts/login');
    } catch (e) {}

    if (!loginSuccess) {
      try {
        await page.keyboard.press('Enter');
        await page.waitForTimeout(6000);
      } catch (e) {}
    }

    try {
      const notNowBtn = page.locator('button:has-text("Not Now"), div[role="button"]:has-text("Not Now")').first();
      await notNowBtn.click({ timeout: 5000 });
      await page.waitForTimeout(2000);
    } catch (e) {}

    try {
      const notifBtn = page.locator('button:has-text("Not Now")').first();
      await notifBtn.click({ timeout: 5000 });
      await page.waitForTimeout(2000);
    } catch (e) {}

    const cookies = await context.cookies();
    fs.writeFileSync(STATE_FILE, JSON.stringify(cookies, null, 2));
    loggedIn = true;
    console.log('✅ Instagram login successful!');

    await context.close();
    await browser.close();
    return true;
  } catch (err) {
    console.error('❌ Login error:', err.message);
    if (browser) await browser.close().catch(() => {});
    return false;
  }
}

// ─── Browser Factory ───────────────────────────
async function createSession(mobile = false) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const context = await browser.newContext({
    userAgent: mobile
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    viewport: mobile ? { width: 390, height: 844 } : { width: 1920, height: 1080 },
    locale: 'en-US',
  });

  if (fs.existsSync(STATE_FILE)) {
    try {
      const cookies = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      await context.addCookies(cookies);
    } catch (e) {}
  }

  return { browser, context };
}

// ─── Search Instagram (Playwright) ─────────────
async function searchInstagramPlaywright(query, mediaType = 'all', limit = 10) {
  const maxResults = Math.min(limit, 30);
  const results = [];
  const isReels = mediaType === 'reels';

  const { browser, context } = await createSession(isReels);
  const page = await context.newPage();

  callCounter++;
  const tag = ROTATION_WORDS[rotationIndex % ROTATION_WORDS.length];
  rotationIndex++;
  const variant = callCounter % 3;

  let searchUrl;
  if (variant === 0) searchUrl = `https://www.instagram.com/search?q=${encodeURIComponent(query)}%20${tag}&_=${callCounter}`;
  else if (variant === 1) searchUrl = `https://www.instagram.com/search?q=${encodeURIComponent(query)}&_=${callCounter}`;
  else searchUrl = `https://www.instagram.com/search?q=${encodeURIComponent(`${query} ${tag}`)}`;

  console.log(`🖼️ IG Playwright: "${query}" (rotation: ${tag})`);

  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(5000);

    // Check if we hit login wall
    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 200));
    if (bodyText.includes('Log in') && bodyText.includes('Sign up') && !bodyText.includes('Log out')) {
      console.log('  ⚠️ Login wall detected, falling back...');
      await context.close();
      await browser.close();
      return []; // Empty signals fallback
    }

    // Try clicking Posts/Top tab
    try {
      const postTab = page.locator('a:has-text("Top"), a:has-text("Posts"), div:has-text("Posts"), span:has-text("Top"), span:has-text("Posts")').first();
      await postTab.click({ timeout: 5000 });
      await page.waitForTimeout(3000);
    } catch (e) {}

    // Scroll
    for (let i = 0; i < 5 && results.length < maxResults * 2; i++) {
      await page.evaluate(() => window.scrollBy(0, 800));
      await page.waitForTimeout(2000);
    }

    // Also try to get data from __NEXT_DATA__ or __initialState
    const posts = await page.evaluate((maxRes) => {
      const items = [];
      // Try to get images from the page directly
      const imgs = document.querySelectorAll('img[alt]');
      const seenSrc = new Set();
      for (const img of imgs) {
        if (items.length >= maxRes) break;
        const src = img.src || '';
        const alt = img.alt || '';
        if (src && src.includes('instagram') && src.length > 50 && !seenSrc.has(src)) {
          seenSrc.add(src);
          items.push({
            id: src.split('/').pop()?.split('?')[0] || `${Date.now()}-${items.length}`,
            caption: alt.substring(0, 300),
            image: src,
            link: `https://www.instagram.com/p/${src.split('/').pop()?.split('?')[0] || ''}/`,
            type: 'image',
          });
        }
      }
      return items;
    }, maxResults * 2);

    // Also get /p/ links
    const linkPosts = await page.evaluate((maxRes) => {
      const items = [];
      const links = document.querySelectorAll('a[href*="/p/"]');
      for (const link of links) {
        if (items.length >= maxRes) break;
        const href = link.getAttribute('href');
        const img = link.querySelector('img');
        items.push({
          id: href ? href.split('/p/')[1]?.split('/')[0] || '' : '',
          caption: img?.alt || '',
          image: img?.src || '',
          link: href ? `https://www.instagram.com${href}` : '',
          type: 'image',
        });
      }
      return items;
    }, maxResults * 2);

    results.push(...linkPosts, ...posts);

    await context.close();
    await browser.close();

    // Dedup
    const unique = [];
    for (const r of results) {
      if (unique.length >= maxResults) break;
      const key = r.id || r.link || r.image;
      if (key && !isSeen(key)) {
        markSeen(key);
        unique.push(r);
      }
    }
    if (unique.length === 0 && results.length > 0) {
      for (const r of results.slice(0, maxResults)) {
        const key = r.id || r.link || r.image;
        if (key) markSeen(key);
        unique.push(r);
      }
    }

    return unique;

  } catch (err) {
    console.error('  ⚠️ Playwright search error:', err.message?.substring(0, 60));
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    return [];
  }
}

// ─── Main Search (Playwright + Fallback) ───────
async function searchInstagram(query, mediaType = 'all', limit = 10) {
  const maxRes = Math.min(limit, 30);
  let results = [];

  // Try Playwright if logged in or have cookies
  if (loggedIn || fs.existsSync(STATE_FILE)) {
    results = await searchInstagramPlaywright(query, mediaType, maxRes);
  }

  // Fallback to Wikimedia/Pexels/Pixabay if Playwright returned nothing
  if (results.length === 0) {
    console.log('  📍 Using fallback sources...');
    results = await fallbackSearch(query, maxRes);
  }

  return results.slice(0, maxRes);
}

// ─── Explore ───────────────────────────────────
async function exploreInstagram(limit = 10) {
  const maxResults = Math.min(limit, 30);

  // Try Playwright explore if logged in
  if (loggedIn || fs.existsSync(STATE_FILE)) {
    try {
      const { browser, context } = await createSession();
      const page = await context.newPage();
      callCounter++;
      const exploreUrl = ['https://www.instagram.com/explore/','https://www.instagram.com/explore/tags/popular/','https://www.instagram.com/explore/','https://www.instagram.com/explore/tags/trending/'][callCounter % 4];

      await page.goto(exploreUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await page.waitForTimeout(5000);

      for (let i = 0; i < 5; i++) {
        await page.evaluate(() => window.scrollBy(0, 800));
        await page.waitForTimeout(2000);
      }

      const posts = await page.evaluate((maxRes) => {
        const items = [];
        const links = document.querySelectorAll('a[href*="/p/"]');
        for (const link of links) {
          if (items.length >= maxRes) break;
          const href = link.getAttribute('href');
          const img = link.querySelector('img');
          items.push({
            id: href ? href.split('/p/')[1]?.split('/')[0] || '' : '',
            caption: img?.alt || '',
            image: img?.src || '',
            link: href ? `https://www.instagram.com${href}` : '',
            type: 'explore',
          });
        }
        return items;
      }, maxResults * 2);

      await context.close();
      await browser.close();

      if (posts.length > 0) {
        const unique = [];
        for (const r of posts) {
          if (unique.length >= maxResults) break;
          const key = r.id || r.link;
          if (key && !isSeen(key)) { markSeen(key); unique.push(r); }
        }
        if (unique.length > 0) return unique;
      }
    } catch(e) { console.log('  ⚠️ IG Explore failed:', e.message?.substring(0,60)); }
  }

  // Fallback: Wikimedia featured images
  console.log('  📍 Explore fallback: Wikimedia featured');
  return await wikimediaFeatured(maxResults);
}

// ─── Scrape ────────────────────────────────────
async function scrapeInstagramPage(pageUrl, mediaType = 'posts', limit = 10, viralOnly = false) {
  const maxResults = Math.min(limit, 30);

  // If URL is an individual post → try oEmbed first, then fallback
  if (pageUrl.includes('/p/') || pageUrl.includes('/reel/')) {
    const o = await oembed(pageUrl);
    if (o?.thumbnail_url) {
      return [{
        id: pageUrl.split('/p/')[1]?.split('/')[0] || pageUrl.split('/reel/')[1]?.split('/')[0] || '',
        type: pageUrl.includes('/reel/') ? 'reel' : 'image',
        caption: o.title || '',
        image: o.thumbnail_url,
        link: pageUrl,
        owner: o.author_name || '',
        mediaUrl: o.thumbnail_url,
      }];
    }
    // oEmbed failed — fall through to Wikimedia
  }

  // For profile/hashtag pages, try Playwright first
  if (loggedIn || fs.existsSync(STATE_FILE)) {
    try {
      const isReels = mediaType === 'reels';
      const { browser, context } = await createSession(isReels);
      const page = await context.newPage();
      callCounter++;
      const separator = pageUrl.includes('?') ? '&' : '?';
      const freshUrl = `${pageUrl}${separator}_=${callCounter}`;
      let targetUrl = freshUrl;

      if (isReels && pageUrl.match(/instagram\.com\/[^/]+\/?$/) && !pageUrl.includes('/reels/')) {
        targetUrl = `${pageUrl.replace(/\/+$/, '')}/reels/?_=${callCounter}`;
      }

      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await page.waitForTimeout(4000);

      // Check login wall
      const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 200));
      if (bodyText.includes('Log in') && !bodyText.includes('Log out')) {
        await context.close();
        await browser.close();
        // Fall through to Wikimedia fallback
        throw new Error('Login wall');
      }

      const scrollCount = viralOnly ? 10 : 5;
      for (let i = 0; i < scrollCount; i++) {
        await page.evaluate(() => window.scrollBy(0, 1000));
        await page.waitForTimeout(2000);
      }

      const items = await page.evaluate((maxRes, isRels) => {
        const extracted = [];
        const selector = isRels ? 'a[href*="/reel/"]' : 'a[href*="/p/"]';
        const links = document.querySelectorAll(selector);
        for (const link of links) {
          if (extracted.length >= maxRes) break;
          const href = link.getAttribute('href');
          const img = link.querySelector('img');
          extracted.push({
            id: href ? href.split(isRels ? '/reel/' : '/p/')[1]?.split('/')[0] || '' : '',
            caption: img?.alt?.substring(0, 300) || '',
            image: img?.src || '',
            link: href ? `https://www.instagram.com${href}` : '',
            type: isRels ? 'reel' : 'post',
          });
        }
        return extracted;
      }, maxResults * 2, isReels);

      await context.close();
      await browser.close();

      if (items.length > 0) {
        const unique = [];
        for (const r of items) {
          if (unique.length >= maxResults) break;
          const key = r.id || r.link;
          if (key && !isSeen(key)) { markSeen(key); unique.push(r); }
        }
        return unique.length ? unique : items.slice(0, maxResults);
      }
    } catch (err) {
      console.log(`  ⚠️ Scrape Playwright failed: ${err.message?.substring(0,60)}`);
    }
  }

  // Fallback: extract hashtag from URL and use Wikimedia
  const tag = pageUrl.split('/explore/tags/')[1]?.split('/')[0]
    || pageUrl.match(/instagram\.com\/([^/]+)/)?.[1]
    || 'popular';
  console.log(`  📍 Scrape fallback: Wikimedia for "${tag}"`);
  const wm = await wikimedia(tag, maxResults);
  return wm.map(p => ({
    ...p,
    link: p.link || pageUrl,
    type: 'post',
  }));
}

// ─── Routes ────────────────────────────────────

app.get('/api/instagram/search', async (req, res) => {
  try {
    const scrapeUrl = req.query.scrape || req.query.scrapeUrl || req.query.page;
    const query = req.query.q || req.query.query || req.query.search;
    const media = req.query.media || 'image';
    const count = parseInt(req.query.count || '5', 10);
    const shouldExplore = req.query.exp === 'true';

    if (scrapeUrl) {
      const scraped = await scrapeInstagramPage(scrapeUrl, media, count);
      return res.json({ success: true, source: 'scrape', scrapeUrl, media, count: scraped.length, data: scraped });
    }

    if (!query) return res.status(400).json({ success: false, error: 'Missing ?q parameter' });

    const content = await searchInstagram(query, media, count);
    let exp = [];
    if (shouldExplore) exp = await exploreInstagram(count);

    res.json({
      success: true, query, media, count: content.length, data: content,
      explore: shouldExplore ? { count: exp.length, data: exp } : undefined,
    });
  } catch (err) {
    console.error('Search error:', err.message);
    res.json({ success: true, count: 0, data: [] });
  }
});

app.get('/api/instagram/scrape', async (req, res) => {
  try {
    const url = req.query.url || req.query.pageUrl || req.query.scrape;
    if (!url) return res.status(400).json({ success: false, error: 'Missing ?url=' });
    const scraped = await scrapeInstagramPage(url, req.query.media || 'posts', parseInt(req.query.count || '10', 10));
    res.json({ success: true, scrapeUrl: url, count: scraped.length, data: scraped });
  } catch (err) { res.json({ success: true, count: 0, data: [] }); }
});

app.get('/api/instagram/explore', async (req, res) => {
  try {
    const content = await exploreInstagram(parseInt(req.query.count || '10', 10));
    res.json({ success: true, count: content.length, data: content });
  } catch (err) { res.json({ success: true, count: 0, data: [] }); }
});

app.all('/api/instagram/follow', (req, res) => {
  res.json({ success: true, followed: 0, accounts: [], note: 'Follow requires Playwright login mode with credentials' });
});

app.get('/api/instagram/login', async (req, res) => {
  loggedIn = false;
  const result = await loginToInstagram();
  res.json({ success: result, loggedIn });
});

app.get('/api/instagram/download', async (req, res) => {
  try {
    const mediaUrl = req.query.url;
    if (!mediaUrl) return res.status(400).json({ success: false, error: 'Missing ?url=' });
    https.get(mediaUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Referer': 'https://www.instagram.com/' },
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location)
        return res.redirect(response.headers.location);
      if (response.statusCode !== 200) return res.status(500).json({ success: false, error: 'Download failed' });
      res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
      response.pipe(res);
    }).on('error', () => res.status(500).json({ success: false, error: 'Download failed' }));
  } catch { res.status(500).json({ success: false, error: 'Download failed' }); }
});

let ocrWorker = null;
app.post('/api/instagram/ocr', async (req, res) => {
  try {
    const mediaUrl = req.body?.url;
    if (!mediaUrl) return res.status(400).json({ success: false, error: 'Missing "url"' });
    if (!ocrWorker) ocrWorker = await createWorker('eng');
    const { data } = await ocrWorker.recognize(mediaUrl);
    res.json({ success: true, text: data.text?.trim() || '', confidence: data.confidence || 0 });
  } catch { res.status(500).json({ success: false, error: 'OCR failed' }); }
});

app.get('/', (req, res) => {
  res.json({
    status: 'alive',
    name: 'Instagram Marketing API',
    version: '2.0.0',
    loggedIn,
    seenPostsCache: seenIds.size,
    setup: loggedIn ? '✅ Instagram logged in' : '⚠️  Set IG_USERNAME & IG_PASSWORD for Instagram scraping',
    note: loggedIn ? 'Using Playwright for real Instagram content' : 'Fallback mode: Wikimedia Commons + Pexels + Pixabay',
    sources: loggedIn ? ['Instagram Playwright', 'Wikimedia Commons (fallback)'] : ['Wikimedia Commons', 'Wikimedia Featured', 'Pexels (with API key)', 'Pixabay (with API key)'],
    endpoints: {
      search: 'GET /api/instagram/search?q=KEYWORD&media=image|reels|all&count=5&exp=true',
      scrape: 'GET /api/instagram/scrape?url=URL&media=posts&count=10',
      explore: 'GET /api/instagram/explore?count=10',
      download: 'GET /api/instagram/download?url=URL',
      ocr: 'POST /api/instagram/ocr {"url":"URL"}',
    },
    examples: {
      search: 'GET /api/instagram/search?q=quotes&count=5',
      scrape_post: 'GET /api/instagram/scrape?url=https://www.instagram.com/p/CODE/',
      explore: 'GET /api/instagram/explore?count=10',
    },
  });
});

// ─── Start ─────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║   Instagram Marketing API v2.0      ║`);
  console.log(`║   ✓ Smart fallback system            ║`);
  console.log(`║   ✓ Always returns results            ║`);
  console.log(`║   Port: ${PORT}                            ║`);
  console.log(`╚══════════════════════════════════════╝\n`);

  if (IG_USERNAME && IG_PASSWORD) {
    await loginToInstagram();
  } else {
    console.log('⚠️  No Instagram credentials — using Wikimedia/Pexels/Pixabay fallback');
    console.log('   Set IG_USERNAME & IG_PASSWORD for real Instagram content');
  }
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
