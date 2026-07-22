const express = require('express');
const { chromium } = require('playwright');
const { createWorker } = require('tesseract.js');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const IG_USERNAME = process.env.IG_USERNAME || '';
const IG_PASSWORD = process.env.IG_PASSWORD || '';
const STATE_FILE = path.join(__dirname, 'instagram_auth.json');

app.use(cors());
app.use(express.json({ limit: '5mb' }));

let loggedIn = false;
let followCount = 0;
let lastFollowReset = Date.now();

// ──────────────────────────────────────────────
// Instagram Login
// ──────────────────────────────────────────────

async function loginToInstagram() {
  if (!IG_USERNAME || !IG_PASSWORD) {
    console.log('⚠️  Instagram credentials not set.');
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

    await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Fill username
    const usernameInput = page.locator('input[name="username"]').first();
    await usernameInput.fill(IG_USERNAME);
    await page.waitForTimeout(500);

    // Fill password
    const passwordInput = page.locator('input[name="password"]').first();
    await passwordInput.fill(IG_PASSWORD);
    await page.waitForTimeout(500);

    // Click login
    const loginBtn = page.locator('button[type="submit"]').first();
    await loginBtn.click();
    await page.waitForTimeout(6000);
    await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});

    // Check for "Save Info" popup and dismiss
    try {
      const notNowBtn = page.locator('button:has-text("Not Now"), button:has-text("Save Info"), div[role="button"]:has-text("Not Now")').first();
      await notNowBtn.click({ timeout: 5000 });
      await page.waitForTimeout(2000);
    } catch (e) {}

    // Check for "Turn on Notifications" popup and dismiss
    try {
      const notNowNotif = page.locator('button:has-text("Not Now")').first();
      await notNowNotif.click({ timeout: 5000 });
      await page.waitForTimeout(2000);
    } catch (e) {}

    // Save session
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

// ──────────────────────────────────────────────
// Browser factory
// ──────────────────────────────────────────────

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

  // Load saved cookies
  if (fs.existsSync(STATE_FILE)) {
    try {
      const cookies = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      await context.addCookies(cookies);
    } catch (e) {}
  }

  return { browser, context };
}

// ──────────────────────────────────────────────
// Search Instagram
// ──────────────────────────────────────────────

async function searchInstagram(query, mediaType = 'all', limit = 10) {
  const maxResults = Math.min(limit, 30);
  const results = [];
  const seenIds = new Set();
  const isReels = mediaType === 'reels';

  const { browser, context } = await createSession(isReels);
  const page = await context.newPage();

  try {
    if (isReels) {
      // ── REEL SEARCH (mobile view) ──
      console.log(`📱 Searching reels for: "${query}"`);
      await page.goto(
        `https://www.instagram.com/search?q=${encodeURIComponent(query)}`,
        { waitUntil: 'domcontentloaded', timeout: 25000 }
      );
      await page.waitForTimeout(4000);

      // Click on "Reels" tab in search results
      try {
        const reelsTab = page.locator('a[href*="/reels/"], a:has-text("Reels"), div:has-text("Reels")').first();
        await reelsTab.click({ timeout: 5000 });
        await page.waitForTimeout(3000);
      } catch (e) {}

      // Scroll to load reels
      for (let i = 0; i < 5 && results.length < maxResults; i++) {
        await page.evaluate(() => window.scrollBy(0, 800));
        await page.waitForTimeout(2000);
      }

      // Extract reel data
      const reels = await page.evaluate((maxRes) => {
        const items = [];
        const articles = document.querySelectorAll('article, div[role="presentation"], video');
        const links = document.querySelectorAll('a[href*="/reel/"]');

        for (const link of links) {
          if (items.length >= maxRes) break;
          const href = link.getAttribute('href');
          const video = link.querySelector('video');
          const img = link.querySelector('img');
          items.push({
            id: href ? href.split('/reel/')[1]?.split('/')[0] || '' : '',
            caption: img?.alt || '',
            thumbnail: img?.src || '',
            videoUrl: video?.src || '',
            link: href ? `https://www.instagram.com${href}` : '',
            type: 'reel',
          });
        }
        return items;
      }, maxResults);
      results.push(...reels);

    } else {
      // ── IMAGE / ALL SEARCH (desktop view) ──
      console.log(`🖼️ Searching images for: "${query}"`);
      await page.goto(
        `https://www.instagram.com/search?q=${encodeURIComponent(query)}`,
        { waitUntil: 'domcontentloaded', timeout: 25000 }
      );
      await page.waitForTimeout(5000);

      // Click on "Top" or "Accounts" then navigate to posts
      try {
        const topTab = page.locator('a:has-text("Top"), a:has-text("Posts"), div:has-text("Posts")').first();
        await topTab.click({ timeout: 5000 });
        await page.waitForTimeout(3000);
      } catch (e) {}

      // Scroll for more content
      for (let i = 0; i < 5 && results.length < maxResults; i++) {
        await page.evaluate(() => window.scrollBy(0, 800));
        await page.waitForTimeout(2000);
      }

      // Extract post data
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
            type: 'image',
          });
        }
        return items;
      }, maxResults);
      results.push(...posts);
    }

    await context.close();
    await browser.close();

    // Deduplicate
    const unique = [];
    const ids = new Set();
    for (const r of results) {
      if (unique.length >= maxResults) break;
      const key = r.id || r.link;
      if (key && !ids.has(key)) {
        ids.add(key);
        unique.push(r);
      }
    }

    console.log(`✅ Found ${unique.length} results`);
    return unique;

  } catch (err) {
    console.error('Search error:', err.message);
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    return results;
  }
}

// ──────────────────────────────────────────────
// Get Explore page content
// ──────────────────────────────────────────────

async function exploreInstagram(limit = 10) {
  const maxResults = Math.min(limit, 30);
  const results = [];

  const { browser, context } = await createSession();
  const page = await context.newPage();

  try {
    console.log('🌐 Loading Explore page...');
    await page.goto('https://www.instagram.com/explore/', { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(5000);

    // Scroll for more
    for (let i = 0; i < 5 && results.length < maxResults; i++) {
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
    }, maxResults);
    results.push(...posts);

    await context.close();
    await browser.close();
    console.log(`✅ Explore: ${results.length} posts`);
    return results.slice(0, maxResults);

  } catch (err) {
    console.error('Explore error:', err.message);
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    return results;
  }
}

// ──────────────────────────────────────────────
// Follow accounts that match niche
// ──────────────────────────────────────────────

async function followRelatedAccounts(query, maxFollow = 5) {
  const followed = [];
  const { browser, context } = await createSession();
  const page = await context.newPage();

  try {
    console.log(`👥 Searching accounts to follow for: "${query}"`);
    await page.goto(
      `https://www.instagram.com/search?q=${encodeURIComponent(query)}`,
      { waitUntil: 'domcontentloaded', timeout: 25000 }
    );
    await page.waitForTimeout(4000);

    // Click "Accounts" tab
    try {
      const accountsTab = page.locator('a:has-text("Accounts"), div:has-text("Accounts")').first();
      await accountsTab.click({ timeout: 5000 });
      await page.waitForTimeout(3000);
    } catch (e) {}

    // Get account list
    const accounts = await page.evaluate(() => {
      const items = [];
      const links = document.querySelectorAll('a[href*="/"]');
      for (const link of links) {
        const href = link.getAttribute('href');
        const img = link.querySelector('img');
        const spans = link.querySelectorAll('span');
        const name = spans.length > 0 ? spans[0].textContent : '';
        // Filter to likely user profiles
        if (href && !href.includes('/p/') && !href.includes('/explore') && !href.includes('/reels') && href.split('/').filter(Boolean).length === 1 && href !== '/') {
          items.push({
            username: href.replace(/\//g, ''),
            name: name || img?.alt || '',
            avatar: img?.src || '',
            link: `https://www.instagram.com${href}`,
          });
        }
      }
      return items;
    });

    console.log(`  Found ${accounts.length} accounts`);

    // Follow each account
    for (let i = 0; i < Math.min(accounts.length, maxFollow) && followed.length < maxFollow; i++) {
      try {
        const acct = accounts[i];
        await page.goto(acct.link, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(3000);

        // Click follow button
        const followBtn = page.locator('button:has-text("Follow"), div[role="button"]:has-text("Follow")').first();
        if (await followBtn.isVisible().catch(() => false)) {
          await followBtn.click();
          await page.waitForTimeout(2000);
          followed.push(acct.username);
          console.log(`  ✅ Followed: ${acct.username}`);

          // Rate limit: wait between follows
          await page.waitForTimeout(4000);
        }
      } catch (e) {
        console.log(`  ⚠️ Could not follow: ${e.message}`);
      }
    }

    await context.close();
    await browser.close();
    console.log(`✅ Followed ${followed.length} accounts`);
    return followed;

  } catch (err) {
    console.error('Follow error:', err.message);
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    return followed;
  }
}

// ──────────────────────────────────────────────
// Scrape any Instagram page
// ──────────────────────────────────────────────

async function scrapeInstagramPage(pageUrl, mediaType = 'posts', limit = 10, viralOnly = false) {
  const maxResults = Math.min(limit, 30);
  const results = [];
  const isReels = mediaType === 'reels';

  const { browser, context } = await createSession(isReels);
  const page = await context.newPage();

  try {
    console.log(`📄 Scraping page: ${pageUrl} (${isReels ? 'reels' : 'posts'}, viral=${viralOnly})`);

    // If reels mode and URL is a profile page, switch to reels tab
    let targetUrl = pageUrl;
    if (isReels && pageUrl.match(/instagram\.com\/[^/]+\/?$/) && !pageUrl.includes('/reels/')) {
      const clean = pageUrl.replace(/\/+$/, '');
      targetUrl = `${clean}/reels/`;
    }

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(4000);

    // Scroll more for viral mode (collect bigger pool)
    const scrollCount = viralOnly ? 10 : 5;
    for (let i = 0; i < scrollCount && results.length < maxResults * (viralOnly ? 3 : 1); i++) {
      await page.evaluate(() => window.scrollBy(0, 1000));
      await page.waitForTimeout(2000);
    }

    // Extract posts or reels
    const items = await page.evaluate((maxRes, isRels) => {
      const extracted = [];
      const selector = isRels ? 'a[href*="/reel/"]' : 'a[href*="/p/"]';
      const links = document.querySelectorAll(selector);

      for (const link of links) {
        if (extracted.length >= maxRes) break;
        const href = link.getAttribute('href');
        const img = link.querySelector('img');
        const video = link.querySelector('video');
        const fullUrl = href ? `https://www.instagram.com${href}` : '';
        extracted.push({
          id: href ? href.split(isRels ? '/reel/' : '/p/')[1]?.split('/')[0] || '' : '',
          caption: img?.alt?.substring(0, 300) || '',
          image: img?.src || '',
          videoUrl: video?.src || '',
          link: fullUrl,
          type: isRels ? 'reel' : 'post',
        });
      }
      return extracted;
    }, maxResults * (viralOnly ? 3 : 1), isReels);

    results.push(...items);

    // If viral mode, rank by engagement
    if (viralOnly && results.length > 0) {
      console.log(`  📊 Ranking ${results.length} posts by engagement...`);

      // Get details (likes/views) for all collected items
      for (let i = 0; i < results.length; i++) {
        try {
          const details = await getPostDetails(results[i].link);
          results[i] = { ...results[i], ...details };
          // Extract numeric likes
          const likesText = results[i].likes || '0';
          const viewsText = results[i].views || '0';
          const likesNum = parseInt(likesText.replace(/[^0-9]/g, '')) || 0;
          const viewsNum = parseInt(viewsText.replace(/[^0-9]/g, '')) || 0;
          results[i].engagement = Math.max(likesNum, viewsNum);
        } catch (e) {
          results[i].engagement = 0;
        }
        await new Promise(r => setTimeout(r, 1000));
      }

      // Sort by engagement descending
      results.sort((a, b) => (b.engagement || 0) - (a.engagement || 0));
      console.log(`  ✅ Top viral post has ${results[0]?.engagement || 0} engagement`);
    }

    await context.close();
    await browser.close();

    // Slice to final limit
    const final = results.slice(0, maxResults);
    console.log(`✅ Scraped ${final.length} items from ${pageUrl}`);
    return final;

  } catch (err) {
    console.error('Scrape error:', err.message);
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    return results.slice(0, maxResults);
  }
}

// ──────────────────────────────────────────────
// Get post details (likes, views, caption)
// ──────────────────────────────────────────────

async function getPostDetails(postUrl) {
  const { browser, context } = await createSession();
  const page = await context.newPage();

  try {
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000);

    const details = await page.evaluate(() => {
      // Get caption
      const captionEl = document.querySelector('h1') || document.querySelector('[data-testid="post-caption"]');
      const caption = captionEl ? captionEl.textContent || '' : '';

      // Get likes count
      const likesEl = document.querySelector('span:has-text("likes"), span:has-text("Likes"), a:has-text("likes")');
      const likes = likesEl ? likesEl.textContent || '' : '';

      // Get views (for reels)
      const viewsEl = document.querySelector('span:has-text("views"), span:has-text("Views")');
      const views = viewsEl ? viewsEl.textContent || '' : '';

      // Get main image/video
      const img = document.querySelector('img[decoding="auto"]');
      const video = document.querySelector('video');
      const mediaUrl = video ? video.src : (img ? img.src : '');

      // Get owner
      const ownerEl = document.querySelector('a[href*="/"]:not([href*="/p/"]):not([href*="/explore"])');
      const owner = ownerEl ? ownerEl.textContent || ownerEl.getAttribute('href') || '' : '';

      return {
        caption,
        likes,
        views,
        mediaUrl,
        owner: owner.replace(/\//g, ''),
      };
    });

    await context.close();
    await browser.close();
    return details;

  } catch (err) {
    console.error('Post details error:', err.message);
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    return { caption: '', likes: '', views: '', mediaUrl: '', owner: '' };
  }
}

// ──────────────────────────────────────────────
// Routes
// ──────────────────────────────────────────────

// ── Search Endpoint ──
// GET /api/instagram/search?q=quotes&media=image&count=5&follow=false&exp=false
// GET /api/instagram/search?scrape=https://www.instagram.com/username/&media=reels&count=5&viral=true
//
// Parameters:
//   q       - Search keyword (required unless scrape is used)
//   scrape  - Full Instagram page URL to scrape all content from
//   media   - "image" (default), "reels", or "all"
//   count   - Number of results (1-30)
//   follow  - "true" to follow relevant accounts
//   exp     - "true" to also fetch explore page content
//   viral   - "true" to get most viral/highest-engagement content

app.get('/api/instagram/search', async (req, res) => {
  try {
    const scrapeUrl = req.query.scrape || req.query.scrapeUrl || req.query.page;
    const query = req.query.q || req.query.query || req.query.search;
    const media = req.query.media || 'image';
    const count = parseInt(req.query.count || '5', 10);
    const shouldFollow = req.query.follow === 'true';
    const shouldExplore = req.query.exp === 'true';
    const viralOnly = req.query.viral === 'true';

    // ── SCRAPE MODE ──
    if (scrapeUrl) {
      console.log(`\n📄 IG SCRAPE: ${scrapeUrl} (media: ${media}, count: ${count}, viral: ${viralOnly})`);
      const scraped = await scrapeInstagramPage(scrapeUrl, media, count, viralOnly);
      return res.json({
        success: true,
        source: 'scrape',
        scrapeUrl,
        media,
        count: scraped.length,
        data: scraped,
      });
    }

    // ── SEARCH MODE ──
    if (!query) return res.status(400).json({ success: false, error: 'Missing ?q parameter (or use ?scrape=URL)' });

    console.log(`\n🔍 IG SEARCH: "${query}" (media: ${media}, count: ${count})`);

    // Search for content
    const content = await searchInstagram(query, media, count);

    // Get details for each result
    const data = [];
    for (const item of content) {
      const details = await getPostDetails(item.link);
      data.push({
        ...item,
        caption: details.caption || item.caption,
        likes: details.likes,
        views: details.views,
        mediaUrl: details.mediaUrl || item.videoUrl || item.image || item.thumbnail,
        owner: details.owner,
      });
      await new Promise(r => setTimeout(r, 1000));
    }

    // Follow accounts if requested
    let followed = [];
    if (shouldFollow) {
      followed = await followRelatedAccounts(query, Math.min(count, 5));
    }

    // Get explore content if requested
    let exploreContent = [];
    if (shouldExplore) {
      exploreContent = await exploreInstagram(count);
      for (let i = 0; i < exploreContent.length; i++) {
        const details = await getPostDetails(exploreContent[i].link);
        exploreContent[i] = { ...exploreContent[i], ...details };
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    res.json({
      success: true,
      query,
      media,
      count: data.length,
      data,
      followed: shouldFollow ? { count: followed.length, accounts: followed } : undefined,
      explore: shouldExplore ? { count: exploreContent.length, data: exploreContent } : undefined,
    });

  } catch (err) {
    console.error('Search endpoint error:', err.message);
    res.json({ success: true, count: 0, data: [] });
  }
});

// ── Scrape Endpoint (standalone) ──
// GET /api/instagram/scrape?url=PROFILE_URL&media=posts|reels&count=10&viral=true

app.get('/api/instagram/scrape', async (req, res) => {
  try {
    const pageUrl = req.query.url || req.query.pageUrl || req.query.scrape;
    if (!pageUrl) return res.status(400).json({ success: false, error: 'Missing ?url=' });

    const media = req.query.media || 'posts';
    const count = parseInt(req.query.count || '10', 10);
    const viralOnly = req.query.viral === 'true';

    console.log(`\n📄 IG SCRAPE (standalone): ${pageUrl}`);
    const scraped = await scrapeInstagramPage(pageUrl, media, count, viralOnly);

    res.json({
      success: true,
      scrapeUrl: pageUrl,
      media,
      count: scraped.length,
      viral: viralOnly,
      data: scraped,
    });
  } catch (err) {
    console.error('Scrape endpoint error:', err.message);
    res.json({ success: true, count: 0, data: [] });
  }
});

// ── Explore Endpoint ──
// GET /api/instagram/explore?count=10

app.get('/api/instagram/explore', async (req, res) => {
  try {
    const count = parseInt(req.query.count || '10', 10);
    const content = await exploreInstagram(count);

    const data = [];
    for (const item of content) {
      const details = await getPostDetails(item.link);
      data.push({ ...item, ...details });
      await new Promise(r => setTimeout(r, 1000));
    }

    res.json({ success: true, count: data.length, data });
  } catch (err) {
    res.json({ success: true, count: 0, data: [] });
  }
});

// ── Follow Endpoint ──
// GET /api/instagram/follow?q=quotes&count=5
// POST /api/instagram/follow { "q": "quotes", "count": 5 }

app.all('/api/instagram/follow', async (req, res) => {
  try {
    const query = req.query.q || req.body?.q || req.query.query || req.body?.query;
    if (!query) return res.status(400).json({ success: false, error: 'Missing ?q parameter' });

    const count = parseInt(req.query.count || req.body?.count || '5', 10);
    const followed = await followRelatedAccounts(query, count);

    res.json({ success: true, query, followed: followed.length, accounts: followed });
  } catch (err) {
    res.json({ success: true, followed: 0, accounts: [] });
  }
});

// ── Download Endpoint ──
// GET /api/instagram/download?url=MEDIA_URL

app.get('/api/instagram/download', async (req, res) => {
  try {
    const mediaUrl = req.query.url;
    if (!mediaUrl) return res.status(400).json({ success: false, error: 'Missing ?url=' });

    const https = require('https');
    https.get(mediaUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.instagram.com/',
      },
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        return res.redirect(response.headers.location);
      }
      if (response.statusCode !== 200) return res.status(500).json({ success: false, error: 'Download failed' });
      res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
      response.pipe(res);
    }).on('error', () => res.status(500).json({ success: false, error: 'Download failed' }));
  } catch {
    res.status(500).json({ success: false, error: 'Download failed' });
  }
});

// ── OCR Endpoint ──
// POST /api/instagram/ocr { "url": "MEDIA_URL" }

let ocrWorker = null;
app.post('/api/instagram/ocr', async (req, res) => {
  try {
    const mediaUrl = req.body?.url;
    if (!mediaUrl) return res.status(400).json({ success: false, error: 'Missing "url"' });
    if (!ocrWorker) ocrWorker = await createWorker('eng');
    const { data } = await ocrWorker.recognize(mediaUrl);
    res.json({ success: true, text: data.text?.trim() || '', confidence: data.confidence || 0 });
  } catch (err) {
    res.status(500).json({ success: false, error: 'OCR failed' });
  }
});

// ── Health Check ──

app.get('/', (req, res) => {
  res.json({
    status: 'alive',
    name: 'Instagram Marketing API',
    version: '1.0.0',
    loggedIn,
    setup: loggedIn
      ? '✅ Instagram logged in'
      : '⚠️  Set IG_USERNAME & IG_PASSWORD in env vars',
    endpoints: {
      search: 'GET /api/instagram/search?q=KEYWORD&media=image|reels|all&count=5&follow=true&exp=true',
      scrape: 'GET /api/instagram/search?scrape=PROFILE_URL&media=posts|reels&count=10&viral=true',
      scrape_standalone: 'GET /api/instagram/scrape?url=PROFILE_URL&media=posts&count=10&viral=true',
      explore: 'GET /api/instagram/explore?count=10',
      follow: 'GET /api/instagram/follow?q=KEYWORD&count=5',
      download: 'GET /api/instagram/download?url=MEDIA_URL',
      ocr: 'POST /api/instagram/ocr { "url": "MEDIA_URL" }',
    },
    examples: {
      search_image: 'GET /api/instagram/search?q=quotes&media=image&count=5',
      search_reels: 'GET /api/instagram/search?q=quotes&media=reels&count=5',
      search_full: 'GET /api/instagram/search?q=quotes&media=all&count=5&follow=true&exp=true',
      scrape_profile: 'GET /api/instagram/search?scrape=https://www.instagram.com/nike/&media=posts&count=10',
      scrape_reels: 'GET /api/instagram/search?scrape=https://www.instagram.com/nike/&media=reels&count=5&viral=true',
      explore: 'GET /api/instagram/explore?count=10',
    },
  });
});

// ──────────────────────────────────────────────
// Start
// ──────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║   Instagram Marketing API Active     ║`);
  console.log(`║   Port: ${PORT}                            ║`);
  console.log(`╚══════════════════════════════════════╝\n`);

  if (IG_USERNAME && IG_PASSWORD) {
    await loginToInstagram();
  } else {
    console.log('⚠️  Set IG_USERNAME & IG_PASSWORD in Render env vars\n');
    console.log('   IG_USERNAME = your Instagram username');
    console.log('   IG_PASSWORD = your Instagram password');
  }
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
