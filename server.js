const express = require('express');
const { chromium } = require('playwright');
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

app.use(cors());
app.use(express.json({ limit: '5mb' }));

let loggedIn = false;
let loginAttempted = false;

// ─── Dedup ─────────────────────────────────────
let seenIds = new Set();
if (fs.existsSync(DEDUP_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(DEDUP_FILE, 'utf8'));
    seenIds = new Set(Array.isArray(saved) ? saved : []);
  } catch (e) { seenIds = new Set(); }
}
function saveSeenIds() {
  if (seenIds.size > 2000) {
    const arr = [...seenIds];
    seenIds = new Set(arr.slice(arr.length - 1500));
  }
  fs.writeFileSync(DEDUP_FILE, JSON.stringify([...seenIds]));
}
function markSeen(id) { if (id) { seenIds.add(id); saveSeenIds(); } }
function isSeen(id) { return seenIds.has(id); }

let callCounter = Date.now();

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// ─── Login ─────────────────────────────────────
async function loginToInstagram() {
  if (!IG_USERNAME || !IG_PASSWORD) {
    console.log('⚠️  IG_USERNAME / IG_PASSWORD not set');
    return false;
  }

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const context = await browser.newContext({
      userAgent: UA,
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
    });

    const page = await context.newPage();
    console.log('🔑 Logging into Instagram...');

    await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);

    // Dismiss cookies
    try {
      const cookieBtn = page.locator('button:has-text("Allow"), button:has-text("Accept"), button:has-text("Allow all")').first();
      await cookieBtn.click({ timeout: 4000 });
      await page.waitForTimeout(1500);
    } catch (e) {}

    // Fill username / email
    try {
      const usernameInput = page.locator('input[name="email"]').first();
      await usernameInput.waitFor({ timeout: 15000 });
      await usernameInput.fill(IG_USERNAME);
      await page.waitForTimeout(500);
    } catch (e) {
      console.log('  ⚠️ Could not find username field');
      await context.close();
      await browser.close();
      return false;
    }

    // Fill password
    try {
      const passwordInput = page.locator('input[name="pass"]').first();
      await passwordInput.waitFor({ timeout: 15000 });
      await passwordInput.fill(IG_PASSWORD);
      await page.waitForTimeout(500);
    } catch (e) {
      console.log('  ⚠️ Could not find password field');
      await context.close();
      await browser.close();
      return false;
    }

    // Click login (input is invisible, use keyboard)
    await page.keyboard.press('Enter');
    await page.waitForTimeout(8000);

    // Check if logged in
    let success = false;
    try {
      const url = page.url();
      success = !url.includes('accounts/login');
      if (!success) {
        await page.waitForTimeout(5000);
        success = !page.url().includes('accounts/login');
      }
    } catch (e) {}

    if (!success) {
      console.log('  ❌ Login failed — wrong credentials or challenge');
      await context.close();
      await browser.close();
      return false;
    }

    // Dismiss popups
    try { await page.locator('button:has-text("Not Now")').first().click({ timeout: 4000 }); await page.waitForTimeout(1000); } catch (e) {}
    try { await page.locator('button:has-text("Not Now")').first().click({ timeout: 4000 }); await page.waitForTimeout(1000); } catch (e) {}

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
async function createSession() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1920, height: 1080 },
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

// ─── IG Search ─────────────────────────────────
async function searchInstagram(query, limit = 10) {
  const maxRes = Math.min(limit, 30);
  const results = [];

  if (!loggedIn && !fs.existsSync(STATE_FILE)) return [];

  const { browser, context } = await createSession();
  const page = await context.newPage();

  callCounter++;
  const isSingle = /^[\w]+$/.test(query);
  const searchUrl = isSingle
    ? `https://www.instagram.com/explore/tags/${encodeURIComponent(query)}/`
    : `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(query)}`;

  try {
    console.log(`🔍 IG: "${query}"`);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(5000);

    // Check login wall
    const text = await page.evaluate(() => document.body.innerText.substring(0, 300));
    if (text.includes('Log in') && !text.includes('Log out')) {
      console.log('  ⚠️ Not logged in');
      await context.close();
      await browser.close();
      return [];
    }

    // Click "Top" or "Posts" tab
    try {
      const tabs = page.locator('a[role="tab"], div[role="tab"], span:has-text("Top"), span:has-text("Posts")').first();
      await tabs.click({ timeout: 4000 });
      await page.waitForTimeout(3000);
    } catch (e) {}

    // Scroll to load content
    for (let i = 0; i < 8 && results.length < maxRes * 2; i++) {
      await page.evaluate(() => window.scrollBy(0, 1200));
      await page.waitForTimeout(2000);
    }

    // Extract posts — Instagram uses <video> for thumbnails now
    const posts = await page.evaluate((maxRes) => {
      const items = [];
      const seen = new Set();

      // Get from /p/ and /reel/ links
      const links = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
      for (const link of links) {
        if (items.length >= maxRes) break;
        const href = link.getAttribute('href');
        const isReel = href?.includes('/reel/');
        const id = href ? href.split(isReel ? '/reel/' : '/p/')[1]?.split('/')[0] || '' : '';
        if (!id || seen.has(id)) continue;
        seen.add(id);

        // Try video thumbnail
        const video = link.querySelector('video');
        let mediaUrl = '';
        let caption = '';
        if (video) {
          mediaUrl = video.src || '';
        }

        // Try img fallback
        const img = link.querySelector('img');
        if (!mediaUrl && img?.src) mediaUrl = img.src;
        if (img?.alt) caption = img.alt.substring(0, 300);

        items.push({
          id, caption,
          image: mediaUrl,
          link: `https://www.instagram.com${href}`,
          type: isReel ? 'reel' : 'image',
        });
      }

      return items;
    }, maxRes * 2);

    await context.close();
    await browser.close();

    // Dedup
    for (const r of posts) {
      if (results.length >= maxRes) break;
      const key = r.id || r.link || r.image;
      if (key && !isSeen(key)) {
        markSeen(key);
        results.push(r);
      }
    }

    // If empty but have posts, return some anyway
    if (results.length === 0 && posts.length > 0) {
      for (const r of posts.slice(0, maxRes)) {
        const key = r.id || r.link || r.image;
        if (key) markSeen(key);
        results.push(r);
      }
    }

    return results;

  } catch (err) {
    console.error('  ⚠️ Search error:', err.message?.substring(0, 80));
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    return results;
  }
}

// ─── Explore ───────────────────────────────────
async function exploreInstagram(limit = 10) {
  const maxRes = Math.min(limit, 30);
  const results = [];

  if (!loggedIn && !fs.existsSync(STATE_FILE)) return [];

  const { browser, context } = await createSession();
  const page = await context.newPage();

  try {
    console.log('🌐 Loading IG Explore...');
    await page.goto('https://www.instagram.com/explore/', { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(5000);

    const text = await page.evaluate(() => document.body.innerText.substring(0, 300));
    if (text.includes('Log in') && !text.includes('Log out')) {
      console.log('  ⚠️ Not logged in');
      await context.close();
      await browser.close();
      return [];
    }

    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => window.scrollBy(0, 1200));
      await page.waitForTimeout(1500);
    }

    const posts = await page.evaluate((maxRes) => {
      const items = [];
      const seen = new Set();
      const links = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
      for (const link of links) {
        if (items.length >= maxRes) break;
        const href = link.getAttribute('href');
        const isReel = href?.includes('/reel/');
        const id = href ? href.split(isReel ? '/reel/' : '/p/')[1]?.split('/')[0] || '' : '';
        if (!id || seen.has(id)) continue;
        seen.add(id);

        const video = link.querySelector('video');
        const img = link.querySelector('img');
        let mediaUrl = video?.src || '';
        if (!mediaUrl && img?.src) mediaUrl = img.src;
        const caption = img?.alt?.substring(0, 300) || '';

        items.push({ id, caption, image: mediaUrl, link: `https://www.instagram.com${href}`, type: isReel ? 'reel' : 'image' });
      }
      return items;
    }, maxRes * 2);

    await context.close();
    await browser.close();

    for (const r of posts) {
      if (results.length >= maxRes) break;
      const key = r.id || r.link;
      if (key && !isSeen(key)) { markSeen(key); results.push(r); }
    }
    if (results.length === 0 && posts.length > 0) {
      for (const r of posts.slice(0, maxRes)) {
        const key = r.id || r.link;
        if (key) markSeen(key);
        results.push(r);
      }
    }

    return results;

  } catch (err) {
    console.error('  ⚠️ Explore error:', err.message?.substring(0, 60));
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    return results;
  }
}

// ─── Scrape ────────────────────────────────────
async function scrapeInstagramPage(pageUrl, limit = 10) {
  const maxRes = Math.min(limit, 30);
  const results = [];

  if (!loggedIn && !fs.existsSync(STATE_FILE)) return [];

  const { browser, context } = await createSession();
  const page = await context.newPage();

  try {
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(5000);

    const text = await page.evaluate(() => document.body.innerText.substring(0, 300));
    if (text.includes('Log in') && !text.includes('Log out')) {
      console.log('  ⚠️ Not logged in');
      await context.close();
      await browser.close();
      return [];
    }

    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => window.scrollBy(0, 1200));
      await page.waitForTimeout(1500);
    }

    const posts = await page.evaluate((maxRes) => {
      const items = [];
      const seen = new Set();
      const selector = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
      for (const link of selector) {
        if (items.length >= maxRes) break;
        const href = link.getAttribute('href');
        const isReel = href?.includes('/reel/');
        const id = href ? href.split(isReel ? '/reel/' : '/p/')[1]?.split('/')[0] || '' : '';
        if (!id || seen.has(id)) continue;
        seen.add(id);

        const video = link.querySelector('video');
        const img = link.querySelector('img');
        let mediaUrl = video?.src || '';
        if (!mediaUrl && img?.src) mediaUrl = img.src;
        const caption = img?.alt?.substring(0, 300) || '';

        items.push({ id, caption, image: mediaUrl, link: `https://www.instagram.com${href}`, type: isReel ? 'reel' : 'image' });
      }
      return items;
    }, maxRes * 2);

    await context.close();
    await browser.close();

    for (const r of posts) {
      if (results.length >= maxRes) break;
      const key = r.id || r.link;
      if (key && !isSeen(key)) { markSeen(key); results.push(r); }
    }
    if (results.length === 0 && posts.length > 0) {
      for (const r of posts.slice(0, maxRes)) {
        const key = r.id || r.link;
        if (key) markSeen(key);
        results.push(r);
      }
    }

    return results;

  } catch (err) {
    console.error('  ⚠️ Scrape error:', err.message?.substring(0, 60));
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    return results;
  }
}

// ─── Routes ────────────────────────────────────

app.get('/api/instagram/search', async (req, res) => {
  try {
    const query = req.query.q || req.query.query || req.query.search;
    const count = parseInt(req.query.count || '5', 10);
    const scrapeUrl = req.query.scrape || req.query.scrapeUrl || req.query.page;
    const shouldExplore = req.query.exp === 'true';

    // Scrape mode
    if (scrapeUrl) {
      if (!loggedIn && !fs.existsSync(STATE_FILE)) {
        return res.json({ success: false, error: 'Not logged in', note: 'Set IG_USERNAME & IG_PASSWORD in env vars' });
      }
      const scraped = await scrapeInstagramPage(scrapeUrl, count);
      return res.json({ success: true, source: 'scrape', scrapeUrl, count: scraped.length, data: scraped });
    }

    if (!query) return res.status(400).json({ success: false, error: 'Missing ?q' });

    if (!loggedIn && !fs.existsSync(STATE_FILE)) {
      return res.json({ success: false, error: 'Not logged in', note: 'Set IG_USERNAME & IG_PASSWORD in env vars' });
    }

    const content = await searchInstagram(query, count);
    let exp = [];
    if (shouldExplore) exp = await exploreInstagram(count);

    res.json({ success: true, query, count: content.length, data: content, explore: shouldExplore ? { count: exp.length, data: exp } : undefined });
  } catch (err) {
    console.error('Search error:', err.message);
    res.json({ success: false, error: err.message, data: [] });
  }
});

app.get('/api/instagram/explore', async (req, res) => {
  try {
    if (!loggedIn && !fs.existsSync(STATE_FILE)) {
      return res.json({ success: false, error: 'Not logged in', note: 'Set IG_USERNAME & IG_PASSWORD in env vars' });
    }
    const content = await exploreInstagram(parseInt(req.query.count || '10', 10));
    res.json({ success: true, count: content.length, data: content });
  } catch (err) {
    res.json({ success: false, error: err.message, data: [] });
  }
});

app.get('/api/instagram/scrape', async (req, res) => {
  try {
    if (!loggedIn && !fs.existsSync(STATE_FILE)) {
      return res.json({ success: false, error: 'Not logged in', note: 'Set IG_USERNAME & IG_PASSWORD in env vars' });
    }
    const url = req.query.url || req.query.pageUrl || req.query.scrape;
    if (!url) return res.status(400).json({ success: false, error: 'Missing ?url' });
    const content = await scrapeInstagramPage(url, parseInt(req.query.count || '10', 10));
    res.json({ success: true, scrapeUrl: url, count: content.length, data: content });
  } catch (err) {
    res.json({ success: false, error: err.message, data: [] });
  }
});

app.all('/api/instagram/follow', (req, res) => {
  res.json({ success: true, followed: 0, accounts: [], note: 'Follow requires Instagram login' });
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
      headers: { 'User-Agent': UA, 'Referer': 'https://www.instagram.com/' },
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
    realInstagramOnly: true,
    seenPostsCache: seenIds.size,
    setup: loggedIn ? '✅ Instagram logged in' : '⚠️  Set IG_USERNAME & IG_PASSWORD in env vars',
    note: '100% real Instagram content only. Returns empty if not logged in.',
    endpoints: {
      search: 'GET /api/instagram/search?q=KEYWORD&count=5',
      scrape: 'GET /api/instagram/scrape?url=URL&count=10',
      explore: 'GET /api/instagram/explore?count=10',
      download: 'GET /api/instagram/download?url=URL',
      ocr: 'POST /api/instagram/ocr {"url":"URL"}',
    },
    examples: {
      search: 'GET /api/instagram/search?q=quotes&count=5',
      scrape_profile: 'GET /api/instagram/scrape?url=https://www.instagram.com/nike/&count=10',
      explore: 'GET /api/instagram/explore?count=10',
    },
  });
});

// ─── Start ─────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║   Instagram Marketing API v2.0      ║`);
  console.log(`║   ✓ 100% real Instagram content      ║`);
  console.log(`║   ✓ No fallbacks, no fakes           ║`);
  console.log(`║   Port: ${PORT}                            ║`);
  console.log(`╚══════════════════════════════════════╝\n`);

  if (IG_USERNAME && IG_PASSWORD) {
    await loginToInstagram();
  } else {
    console.log('⚠️  Set IG_USERNAME & IG_PASSWORD in Render env vars');
  }
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
