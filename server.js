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
const DEDUP_FILE = path.join(__dirname, 'seen_ids.json');
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

app.use(cors());
app.use(express.json({ limit: '5mb' }));

let loggedIn = false;

// ──────────────────────────────────────────────
// Freshness system — dedup + rotation
// ──────────────────────────────────────────────

// Load previously seen IDs so we never return the same post twice
let seenIds = new Set();
if (fs.existsSync(DEDUP_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(DEDUP_FILE, 'utf8'));
    seenIds = new Set(Array.isArray(saved) ? saved : []);
    console.log(`📌 Loaded ${seenIds.size} seen post IDs`);
  } catch (e) { seenIds = new Set(); }
}
// Trim to last 2000 to keep file small
function trimSeenIds() {
  if (seenIds.size > 2000) {
    const arr = [...seenIds];
    seenIds = new Set(arr.slice(arr.length - 1500));
  }
}
function saveSeenIds() {
  trimSeenIds();
  fs.writeFileSync(DEDUP_FILE, JSON.stringify([...seenIds]));
}
function markSeen(id) { if (id) { seenIds.add(id); saveSeenIds(); } }
function isSeen(id) { return seenIds.has(id); }

// Word pool — every call picks a different rotation word so search results
// are always different even for the same query
const ROTATION_WORDS = [
  'popular', 'trending', 'viral', 'best', 'top',
  'new', 'latest', 'amazing', 'inspiring', 'creative',
  'daily', 'hot', 'mustsee', 'favorite', 'mood',
  'vibes', 'aesthetic', 'goals', 'love', 'life',
  'art', 'beautiful', 'feel', 'style', 'nice',
  'cool', 'fun', 'great', 'awesome', 'perfect',
  'dream', 'hope', 'smile', 'happy', 'peace',
  'mindset', 'focus', 'success', 'win', 'grind',
  'rise', 'shine', 'vision', 'purpose', 'passion',
  'believe', 'achieve', 'inspire', 'motivate', 'drive',
];
let rotationIndex = 0;
// Call counter appended to URLs — forces Instagram to see a "new" page each time
let callCounter = Date.now();

function getRotationWord() {
  const word = ROTATION_WORDS[rotationIndex % ROTATION_WORDS.length];
  rotationIndex++;
  return word;
}

function getFreshSearchUrl(baseQuery) {
  callCounter++;
  const tag = getRotationWord();
  // Rotate between different search forms: sometimes append a tag,
  // sometimes use just the base, sometimes add the counter as noise
  const variant = callCounter % 3;
  if (variant === 0) return `${encodeURIComponent(baseQuery)}%20${tag}&_=${callCounter}`;
  if (variant === 1) return `${encodeURIComponent(baseQuery)}&_=${callCounter}`;
  return `${encodeURIComponent(`${baseQuery} ${tag}`)}`;
}

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

    // ── Load login page with retry ──
    console.log('  Loading login page...');

    let pageLoaded = false;
    for (let attempt = 0; attempt < 3 && !pageLoaded; attempt++) {
      try {
        await page.goto(attempt === 2 ? 'https://www.instagram.com/' : 'https://www.instagram.com/accounts/login/', {
          waitUntil: 'commit',
          timeout: 30000,
        });
        console.log(`  Attempt ${attempt + 1}: URL=${page.url().substring(0, 80)}`);
        // Critical: wait LONG for React to render (Render is slow)
        console.log('  Waiting for React app to render...');
        await page.waitForTimeout(12000);

        // Check if page has any content
        const hasContent = await page.evaluate(() => document.body?.innerHTML?.length > 100).catch(() => false);
        if (hasContent) {
          pageLoaded = true;
          console.log('  ✅ Page has content');
        } else {
          console.log(`  Empty page, retrying...`);
          await page.waitForTimeout(3000);
        }
      } catch (e) {
        console.log(`  Attempt ${attempt + 1} failed: ${e.message?.substring(0, 60)}`);
        await page.waitForTimeout(3000);
      }
    }

    if (!pageLoaded) {
      // Last ditch — try the i.instagram.com (basic mobile) login
      console.log('  Trying mobile login...');
      await page.goto('https://www.instagram.com/accounts/login/?next=%2F', {
        waitUntil: 'commit',
        timeout: 30000,
      }).catch(() => {});
      await page.waitForTimeout(15000);
    }

    console.log(`  Final URL: ${page.url().substring(0, 80)}`);

    // ── Handle landing page ──
    // If no form on the page, Instagram probably showed a splash/marketing page
    // Look for "Log in" button anywhere and click it
    let formFound = await page.evaluate(() => document.querySelectorAll('input').length >= 2).catch(() => false);
    if (!formFound) {
      console.log('  No input form, clicking any "Log in" link...');
      try {
        const loginBtn = page.locator('a[href*="login"], button:has-text("Log in"), div[role="button"]:has-text("Log in")').first();
        await loginBtn.click({ timeout: 5000 });
        await page.waitForTimeout(5000);
        formFound = await page.evaluate(() => document.querySelectorAll('input').length >= 2).catch(() => false);
      } catch (e) {
        console.log('  No "Log in" button found either');
      }
    }

    // ── Debug dump ──
    const debugInfo = await page.evaluate(() => {
      const info = {
        title: document.title,
        url: location.href,
        bodyHTML: document.body?.innerHTML?.substring(0, 2000) || 'no body',
        inputCount: document.querySelectorAll('input').length,
        inputs: [],
        buttonCount: document.querySelectorAll('button, div[role="button"]').length,
        buttons: [],
        forms: document.querySelectorAll('form').length,
        links: document.querySelectorAll('a').length,
      };
      document.querySelectorAll('input').forEach(el => {
        info.inputs.push({
          type: el.type,
          name: el.name,
          placeholder: el.placeholder,
          autocomplete: el.autocomplete,
          'aria-label': el.getAttribute('aria-label'),
          id: el.id,
          class: el.className?.substring(0, 60),
          visible: el.offsetParent !== null,
        });
      });
      document.querySelectorAll('button').forEach(el => {
        info.buttons.push({
          text: el.textContent?.substring(0, 50),
          type: el.type,
          visible: el.offsetParent !== null,
        });
      });
      return info;
    });
    console.log(`  Page: "${debugInfo.title}"`);
    console.log(`  Inputs: ${debugInfo.inputCount}, Buttons: ${debugInfo.buttonCount}, Forms: ${debugInfo.forms}`);
    if (debugInfo.inputs.length > 0) {
      console.log(`  Input[0]: type=${debugInfo.inputs[0].type}, name=${debugInfo.inputs[0].name}, placeholder="${debugInfo.inputs[0].placeholder}", autocomplete=${debugInfo.inputs[0].autocomplete}, aria-label="${debugInfo.inputs[0]['aria-label']}"`);
    }

    // Try up to 3 times to find input fields
    for (let attempt = 0; attempt < 3; attempt++) {
      const hasInputs = await page.evaluate(() => {
        return document.querySelectorAll('input:not([type="hidden"])').length;
      });

      if (hasInputs >= 2) {
        console.log(`  Found ${hasInputs} input fields`);
        break;
      }

      if (attempt < 2) {
        console.log(`  ⚠️ Only ${hasInputs} inputs found (attempt ${attempt + 1}), waiting...`);
        await page.waitForTimeout(4000);

        // Maybe there's a cookie wall blocking the form — try dismissing anything
        try {
          const anyBtn = page.locator('button, div[role="button"], a').filter({ hasText: /allow|accept|log in|sign in/i }).first();
          await anyBtn.click({ timeout: 2000 });
          await page.waitForTimeout(3000);
        } catch (e) {}
      }
    }

    // Fill username + password by index (always input[0] = username, input[1] = password)
    // NOTE: page.evaluate only accepts ONE arg — pass as object
    const filled = await page.evaluate(({ username, password }) => {
      const inputs = document.querySelectorAll('input:not([type="hidden"])');
      if (inputs.length < 2) return { found: inputs.length, filled: false };

      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;

      setter.call(inputs[0], username);
      inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      inputs[0].dispatchEvent(new Event('change', { bubbles: true }));

      setter.call(inputs[1], password);
      inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
      inputs[1].dispatchEvent(new Event('change', { bubbles: true }));

      return { found: inputs.length, filled: true };
    }, { username: IG_USERNAME, password: IG_PASSWORD });

    console.log(`  Fields: ${filled.found} found, ${filled.filled ? '✅ filled' : '❌ not filled'}`);

    // Fallback: Playwright locator fill
    if (!filled.filled) {
      const inputs = await page.locator('input').all().catch(() => []);
      if (inputs.length >= 1) await inputs[0].fill(IG_USERNAME, { timeout: 5000 }).catch(() => {});
      if (inputs.length >= 2) await inputs[1].fill(IG_PASSWORD, { timeout: 5000 }).catch(() => {});
    }

    await page.waitForTimeout(1500);

    // Submit: try to find and click Log In button, or press Enter
    const buttons = await page.locator('button, div[role="button"]').all().catch(() => []);
    let submitted = false;
    for (const btn of buttons) {
      const txt = await btn.textContent().catch(() => '');
      if (/log in|sign in|submit/i.test(txt)) {
        await btn.click({ force: true }).catch(() => {});
        submitted = true;
        console.log('  ✅ Clicked Log In');
        break;
      }
    }
    if (!submitted) {
      if (buttons.length > 0) {
        await buttons[buttons.length - 1].click({ force: true }).catch(() => {});
        console.log('  Clicked last button');
      } else {
        await page.keyboard.press('Enter');
        console.log('  Pressed Enter');
      }
    }

    // Wait for redirect away from login page
    console.log('  Waiting for login to complete...');
    await page.waitForTimeout(10000);

    try {
      await page.waitForURL(/instagram\.com\/(?!accounts\/login)/, { timeout: 25000 });
      console.log('  ✅ Redirected from login');
    } catch (e) {
      console.log('  ⚠️ Still on login page, retrying submit...');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(8000);
      try {
        await page.waitForURL(/instagram\.com\/(?!accounts\/login)/, { timeout: 20000 });
      } catch (e2) {}

      // If still on login, check for Account Center / Facebook linking / security checkpoint
      const stillLogin = await page.evaluate(() => location.href.includes('accounts/login')).catch(() => true);
      if (stillLogin) {
        // Check for security checkpoint (challenge/verify)
        const challengeDetected = await page.evaluate(() => {
          const text = document.body?.innerText || '';
          return {
            isChallenge: /challenge|verify it's you|security code|enter confirmation/i.test(text),
            isAccountCenter: /accounts center|continue as|try another/i.test(text),
            isFacebookSSO: /continue with facebook|log in with facebook/i.test(text),
            textSnippet: text.substring(0, 300),
          };
        }).catch(() => ({}));

        console.log('  ⚠️ Still on login page!', JSON.stringify(challengeDetected));

        if (challengeDetected?.isChallenge) {
          console.log('  🔐 SECURITY CHECKPOINT — Instagram wants email/SMS verification');
          console.log('  ➡️ Go to instagram.com on your PHONE or desktop browser');
          console.log('  ➡️ Log in manually — Instagram will send you a code');
          console.log('  ➡️ Complete the verification ONCE, then restart Render service');
        } else {
          console.log('  ➡️ Log into this Instagram account MANUALLY from your phone/desktop first');
          console.log('  ➡️ Then restart Render service');
        }
      }
    }

    // Handle Account Center / "Continue as [user]" / one-tap login
    try {
      const continueAsBtn = page.locator('button, div[role="button"], a').filter({
        hasText: /continue as|not now|try another|use without account/i
      }).first();
      if (await continueAsBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        const txt = await continueAsBtn.textContent().catch(() => '');
        console.log(`  📌 Account Center prompt: "${txt}"`);
        if (/continue as/i.test(txt)) {
          await continueAsBtn.click();
          await page.waitForTimeout(5000);
        }
      }
    } catch (e) {}

    // Handle "Save Info" popup
    try {
      const notNowBtn = page.locator('button:has-text("Not Now"), div[role="button"]:has-text("Not Now"), button:has-text("Save Info")').first();
      await notNowBtn.click({ timeout: 5000 });
      await page.waitForTimeout(2000);
    } catch (e) {}

    // Handle notifications popup
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

  if (fs.existsSync(STATE_FILE)) {
    try {
      const cookies = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      await context.addCookies(cookies);
    } catch (e) {}
  }

  return { browser, context };
}

// ──────────────────────────────────────────────
// DeepSeek AI — intelligent page analysis fallback
// ──────────────────────────────────────────────

async function deepseekAnalyzePage(page, query, mediaType) {
  if (!DEEPSEEK_API_KEY) return [];

  // Get page HTML and text
  const pageData = await page.evaluate(() => {
    return {
      url: location.href,
      title: document.title,
      text: document.body?.innerText?.substring(0, 5000) || '',
      html: document.body?.innerHTML?.substring(0, 8000) || '',
      links: [...document.querySelectorAll('a[href*="/reel/"], a[href*="/p/"]')].slice(0, 20).map(a => ({
        href: a.getAttribute('href'),
        img: a.querySelector('img')?.src || '',
        alt: a.querySelector('img')?.alt || '',
      })),
      videos: [...document.querySelectorAll('video')].slice(0, 10).map(v => ({
        src: v.getAttribute('src'),
        poster: v.getAttribute('poster'),
      })),
      imgs: [...document.querySelectorAll('img[src]')].slice(0, 20).map(i => ({
        src: i.src,
        alt: i.alt,
      })),
    };
  }).catch(() => ({}));

  if (!pageData.html && !pageData.text) return [];

  console.log('  🤖 Asking DeepSeek to find content...');

  try {
    const https = require('https');
    const body = JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [
        {
          role: 'system',
          content: `You are an Instagram API that extracts content from page data.
The user searched for "${query}" looking for ${mediaType === 'reels' ? 'REELS (video content)' : 'POSTS/IMAGES'}.

Return ONLY a valid JSON array of objects. Each object must have:
- "id": unique identifier (from URL or random)
- "caption": text description
- "link": full Instagram URL (add https://www.instagram.com prefix if missing)
- ${mediaType === 'reels' ? '"videoUrl": video source URL or poster URL' : '"image": image source URL'}
- "type": "${mediaType === 'reels' ? 'reel' : 'image'}"
- "confidence": number 0-100 how confident this matches the query

Max 10 items. Return ONLY the JSON array, no other text. If nothing relevant, return [].`
        },
        {
          role: 'user',
          content: `Page URL: ${pageData.url}
Page title: ${pageData.title}

Links found: ${JSON.stringify(pageData.links)}
${mediaType === 'reels' ? `Videos: ${JSON.stringify(pageData.videos)}` : `Images: ${JSON.stringify(pageData.imgs)}`}
Page text (first 3000 chars): ${pageData.text.substring(0, 3000)}`
        },
      ],
      temperature: 0.1,
      max_tokens: 2000,
    });

    const result = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.deepseek.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
        },
        timeout: 30000,
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed);
          } catch (e) { reject(new Error('Parse failed')); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      req.write(body);
      req.end();
    });

    const content = result?.choices?.[0]?.message?.content || '';
    // Parse JSON from the response (handle markdown-wrapped JSON)
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const items = JSON.parse(jsonMatch[0]);
      if (Array.isArray(items) && items.length > 0) {
        console.log(`  ✅ DeepSeek found ${items.length} items`);
        return items.filter(i => i.confidence > 30).slice(0, 10);
      }
    }
    return [];
  } catch (err) {
    console.log(`  ⚠️ DeepSeek error: ${err.message}`);
    return [];
  }
}

// ──────────────────────────────────────────────
// Search Instagram — with freshness rotation
// ──────────────────────────────────────────────

async function searchInstagram(query, mediaType = 'all', limit = 10) {
  const maxResults = Math.min(limit, 30);
  const results = [];
  const isReels = mediaType === 'reels';

  const { browser, context } = await createSession(isReels);
  const page = await context.newPage();

  // Use fresh rotation to ensure different results every time
  const freshQuery = getFreshSearchUrl(query);
  const cacheBust = `&_=${callCounter}_${Date.now()}`;

  try {
    if (isReels) {
      console.log(`📱 Searching reels for: "${query}"`);

      // Instagram reels work as a TikTok-style feed at /reels/
      // For search-based reels, use the reels search URL
      const urls = [
        `https://www.instagram.com/reels/search/?q=${encodeURIComponent(query)}`,
        `https://www.instagram.com/reels/`,
      ];
      // Try each URL
      let contentFound = false;
      for (const url of urls) {
        if (contentFound) break;
        console.log(`  Trying: ${url}`);
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await page.waitForTimeout(8000);
          // Check if page has reel links
          const count = await page.evaluate(() => {
            return document.querySelectorAll('a[href*="/reel/"], article video, video[src]').length;
          }).catch(() => 0);
          if (count > 0) {
            contentFound = true;
            console.log(`  ✅ Found ${count} reel elements`);
          }
        } catch (e) {
          console.log(`  ⚠️ URL failed, trying next`);
        }
      }

      // If nothing found on reels pages, try hashtag page
      if (!contentFound) {
        const tag = query.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
        const hashtagUrl = `https://www.instagram.com/explore/tags/${tag}/`;
        console.log(`  Trying hashtag: ${hashtagUrl}`);
        await page.goto(hashtagUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(8000);
      }

      // Heavy scroll to load content
      console.log('  Scrolling...');
      for (let i = 0; i < 10; i++) {
        await page.evaluate(() => window.scrollBy(0, 1000));
        await page.waitForTimeout(2000);
      }

      // Extract using multiple methods
      const reelMax = maxResults * 2;
      const reels = await page.evaluate((maxRes) => {
        const items = [];

        // Method 1: Links to /reel/
        const reelLinks = document.querySelectorAll('a[href*="/reel/"]');
        for (const link of reelLinks) {
          if (items.length >= maxRes) break;
          const href = link.getAttribute('href');
          const img = link.querySelector('img');
          const video = link.querySelector('video');
          items.push({
            id: href?.split('/reel/')[1]?.split('/')[0] || '',
            caption: img?.alt || '',
            thumbnail: img?.src || '',
            videoUrl: video?.src || '',
            link: href ? `https://www.instagram.com${href}` : '',
            type: 'reel',
          });
        }

        // Method 2: Look for videos inside articles (newer IG layout)
        if (items.length < maxRes) {
          const articles = document.querySelectorAll('article, div[role="presentation"]');
          for (const article of articles) {
            if (items.length >= maxRes) break;
            const video = article.querySelector('video');
            const img = article.querySelector('img');
            const link = article.querySelector('a');
            if (video || img) {
              const href = link?.getAttribute('href') || '';
              items.push({
                id: href?.split('/reel/')[1]?.split('/')[0] || href?.split('/p/')[1]?.split('/')[0] || '',
                caption: img?.alt || video?.title || '',
                thumbnail: img?.src || '',
                videoUrl: video?.src || '',
                link: href.startsWith('/') ? `https://www.instagram.com${href}` : href,
                type: 'reel',
              });
            }
          }
        }

        // Method 3: Standalone video elements with poster
        if (items.length < maxRes) {
          const videos = document.querySelectorAll('video[poster], video[src]');
          for (const video of videos) {
            if (items.length >= maxRes) break;
            const poster = video.getAttribute('poster');
            const src = video.getAttribute('src');
            const parentLink = video.closest('a');
            const href = parentLink?.getAttribute('href') || '';
            if (src && !items.some(i => i.videoUrl === src)) {
              items.push({
                id: href?.split('/reel/')[1]?.split('/')[0] || '',
                caption: '',
                thumbnail: poster || '',
                videoUrl: src,
                link: href.startsWith('/') ? `https://www.instagram.com${href}` : href,
                type: 'reel',
              });
            }
          }
        }

        return items;
      }, reelMax);
      results.push(...reels);
      console.log(`  Extracted ${reels.length} reels`);

    } else {
      // ── IMAGE SEARCH ──
      console.log(`🖼️ Searching images for: "${query}"`);

      // Use hashtag page directly — more stable than search page
      const tag = query.replace(/[^a-zA-Z0-9 ]/g, '').trim().split(' ')[0].toLowerCase();
      const hashtagUrl = `https://www.instagram.com/explore/tags/${tag}/`;
      console.log(`  Using hashtag page: ${hashtagUrl}`);

      await page.goto(hashtagUrl, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(async () => {
        // Fallback to search
        console.log('  Hashtag failed, trying search...');
        await page.goto(
          `https://www.instagram.com/search?q=${freshQuery}${cacheBust}`,
          { waitUntil: 'domcontentloaded', timeout: 25000 }
        ).catch(() => {});
      });
      await page.waitForTimeout(8000);

      // Scroll for more content
      console.log('  Scrolling...');
      for (let i = 0; i < 8; i++) {
        await page.evaluate(() => window.scrollBy(0, 1000));
        await page.waitForTimeout(2000);
      }

      // Extract posts with multiple methods
      const postMax = maxResults * 2;
      const posts = await page.evaluate((maxRes) => {
        const items = [];

        // Method 1: Standard /p/ links
        const postLinks = document.querySelectorAll('a[href*="/p/"]');
        for (const link of postLinks) {
          if (items.length >= maxRes) break;
          const href = link.getAttribute('href');
          const img = link.querySelector('img');
          if (img?.src) {
            items.push({
              id: href?.split('/p/')[1]?.split('/')[0] || '',
              caption: img.alt || '',
              image: img.src,
              link: href ? `https://www.instagram.com${href}` : '',
              type: 'image',
            });
          }
        }

        // Method 2: Any linked image inside articles
        if (items.length < maxRes) {
          const imgs = document.querySelectorAll('article img[src], div[role="presentation"] img[src]');
          const seen = new Set();
          for (const img of imgs) {
            if (items.length >= maxRes) break;
            if (seen.has(img.src) || !img.src) continue;
            seen.add(img.src);
            const parentLink = img.closest('a');
            const href = parentLink?.getAttribute('href') || '';
            items.push({
              id: href?.split('/p/')[1]?.split('/')[0] || '',
              caption: img.alt || '',
              image: img.src,
              link: href.startsWith('/') ? `https://www.instagram.com${href}` : href,
              type: 'image',
            });
          }
        }

        return items;
      }, postMax);
      results.push(...posts);
      console.log(`  Extracted ${posts.length} images`);
    }

    // If no results found, try DeepSeek AI analysis
    if (results.length === 0 && DEEPSEEK_API_KEY) {
      console.log('  ⚠️ No results from selectors, trying DeepSeek AI...');
      const aiResults = await deepseekAnalyzePage(page, query, mediaType);
      results.push(...aiResults);
    }

    await context.close();
    await browser.close();

    // Dedup against ALL previously seen IDs globally
    const unique = [];
    for (const r of results) {
      if (unique.length >= maxResults) break;
      const key = r.id || r.link;
      if (key && !isSeen(key)) {
        markSeen(key);
        unique.push(r);
      }
    }

    // If too many were seen, still return whatever fresh ones we found
    if (unique.length === 0 && results.length > 0) {
      // All were seen before — return the first few anyway so user isn't empty
      console.log('  ⚠️ Most results already seen, returning newest');
      for (const r of results.slice(0, maxResults)) {
        const key = r.id || r.link;
        if (key) markSeen(key);
        unique.push(r);
      }
    }

    console.log(`✅ Found ${unique.length} fresh results`);
    return unique;

  } catch (err) {
    console.error('Search error:', err.message);
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    const keyed = [];
    for (const r of results) {
      const key = r.id || r.link;
      if (key && !isSeen(key) && keyed.length < maxResults) {
        markSeen(key);
        keyed.push(r);
      }
    }
    return keyed.length ? keyed : results.slice(0, maxResults);
  }
}

// ──────────────────────────────────────────────
// Explore — with rotation through explore pages
// ──────────────────────────────────────────────

async function exploreInstagram(limit = 10) {
  const maxResults = Math.min(limit, 30);
  const results = [];

  const { browser, context } = await createSession();
  const page = await context.newPage();

  // Rotate between explore and explore/tags/ for variety
  callCounter++;
  const exploreUrls = [
    'https://www.instagram.com/explore/',
    'https://www.instagram.com/explore/tags/popular/',
    'https://www.instagram.com/explore/',
    'https://www.instagram.com/explore/tags/trending/',
  ];
  const exploreUrl = exploreUrls[callCounter % exploreUrls.length];

  try {
    console.log(`🌐 Loading: ${exploreUrl}`);
    await page.goto(exploreUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(5000);

    for (let i = 0; i < 5 && results.length < maxResults * 2; i++) {
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
    results.push(...posts);

    await context.close();
    await browser.close();

    // Dedup
    const unique = [];
    for (const r of results) {
      if (unique.length >= maxResults) break;
      const key = r.id || r.link;
      if (key && !isSeen(key)) {
        markSeen(key);
        unique.push(r);
      }
    }
    if (unique.length === 0 && results.length > 0) {
      for (const r of results.slice(0, maxResults)) {
        const key = r.id || r.link;
        if (key) markSeen(key);
        unique.push(r);
      }
    }

    console.log(`✅ Explore: ${unique.length} fresh posts`);
    return unique;

  } catch (err) {
    console.error('Explore error:', err.message);
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    const keyed = [];
    for (const r of results) {
      const key = r.id || r.link;
      if (key && !isSeen(key) && keyed.length < maxResults) {
        markSeen(key);
        keyed.push(r);
      }
    }
    return keyed.length ? keyed : results.slice(0, maxResults);
  }
}

// ──────────────────────────────────────────────
// Follow accounts
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

    try {
      const accountsTab = page.locator('a:has-text("Accounts"), div:has-text("Accounts")').first();
      await accountsTab.click({ timeout: 5000 });
      await page.waitForTimeout(3000);
    } catch (e) {}

    const accounts = await page.evaluate(() => {
      const items = [];
      const links = document.querySelectorAll('a[href*="/"]');
      for (const link of links) {
        const href = link.getAttribute('href');
        const img = link.querySelector('img');
        const spans = link.querySelectorAll('span');
        const name = spans.length > 0 ? spans[0].textContent : '';
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

    for (let i = 0; i < Math.min(accounts.length, maxFollow) && followed.length < maxFollow; i++) {
      try {
        const acct = accounts[i];
        await page.goto(acct.link, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(3000);

        const followBtn = page.locator('button:has-text("Follow"), div[role="button"]:has-text("Follow")').first();
        if (await followBtn.isVisible().catch(() => false)) {
          await followBtn.click();
          await page.waitForTimeout(2000);
          followed.push(acct.username);
          console.log(`  ✅ Followed: ${acct.username}`);
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

  // For scrape mode, rotate the URL with a timestamp so Instagram sees a fresh page
  callCounter++;
  const separator = pageUrl.includes('?') ? '&' : '?';
  const freshUrl = `${pageUrl}${separator}_=${callCounter}`;

  const results = [];
  const isReels = mediaType === 'reels';

  const { browser, context } = await createSession(isReels);
  const page = await context.newPage();

  try {
    let targetUrl = freshUrl;
    if (isReels && pageUrl.match(/instagram\.com\/[^/]+\/?$/) && !pageUrl.includes('/reels/')) {
      const clean = pageUrl.replace(/\/+$/, '');
      targetUrl = `${clean}/reels/?_=${callCounter}`;
    }

    console.log(`📄 Scraping: ${targetUrl} (viral=${viralOnly})`);

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(4000);

    const scrollCount = viralOnly ? 10 : 5;
    for (let i = 0; i < scrollCount && results.length < maxResults * (viralOnly ? 3 : 1); i++) {
      await page.evaluate(() => window.scrollBy(0, 1000));
      await page.waitForTimeout(2000);
    }

    const items = await page.evaluate(({ maxRes, isRels }) => {
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
    }, { maxRes: maxResults * (viralOnly ? 3 : 1), isRels });

    results.push(...items);

    if (viralOnly && results.length > 0) {
      console.log(`  📊 Ranking ${results.length} posts by engagement...`);
      for (let i = 0; i < results.length; i++) {
        try {
          const details = await getPostDetails(results[i].link);
          results[i] = { ...results[i], ...details };
          const likesText = results[i].likes || '0';
          const viewsText = results[i].views || '0';
          const likesNum = parseInt(likesText.replace(/[^0-9]/g, '')) || 0;
          const viewsNum = parseInt(viewsText.replace(/[^0-9]/g, '')) || 0;
          results[i].engagement = Math.max(likesNum, viewsNum);
        } catch (e) { results[i].engagement = 0; }
        await new Promise(r => setTimeout(r, 1000));
      }
      results.sort((a, b) => (b.engagement || 0) - (a.engagement || 0));
    }

    await context.close();
    await browser.close();

    // Dedup against seen IDs
    const unique = [];
    for (const r of results) {
      if (unique.length >= maxResults) break;
      const key = r.id || r.link;
      if (key && !isSeen(key)) {
        markSeen(key);
        unique.push(r);
      }
    }
    if (unique.length === 0 && results.length > 0) {
      for (const r of results.slice(0, maxResults)) {
        const key = r.id || r.link;
        if (key) markSeen(key);
        unique.push(r);
      }
    }

    console.log(`✅ Scraped ${unique.length} fresh items`);
    return unique;

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
      const captionEl = document.querySelector('h1') || document.querySelector('[data-testid="post-caption"]');
      const caption = captionEl ? captionEl.textContent || '' : '';

      const likesEl = document.querySelector('span:has-text("likes"), span:has-text("Likes"), a:has-text("likes")');
      const likes = likesEl ? likesEl.textContent || '' : '';

      const viewsEl = document.querySelector('span:has-text("views"), span:has-text("Views")');
      const views = viewsEl ? viewsEl.textContent || '' : '';

      const img = document.querySelector('img[decoding="auto"]');
      const video = document.querySelector('video');
      const mediaUrl = video ? video.src : (img ? img.src : '');

      const ownerEl = document.querySelector('a[href*="/"]:not([href*="/p/"]):not([href*="/explore"])');
      const owner = ownerEl ? ownerEl.textContent || ownerEl.getAttribute('href') || '' : '';

      return { caption, likes, views, mediaUrl, owner: owner.replace(/\//g, '') };
    });

    await context.close();
    await browser.close();
    return details;

  } catch (err) {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    return { caption: '', likes: '', views: '', mediaUrl: '', owner: '' };
  }
}

// ──────────────────────────────────────────────
// Routes
// ──────────────────────────────────────────────

app.get('/api/instagram/search', async (req, res) => {
  try {
    const scrapeUrl = req.query.scrape || req.query.scrapeUrl || req.query.page;
    const query = req.query.q || req.query.query || req.query.search;
    const media = req.query.media || 'image';
    const count = parseInt(req.query.count || '5', 10);
    const shouldFollow = req.query.follow === 'true';
    const shouldExplore = req.query.exp === 'true';
    const viralOnly = req.query.viral === 'true';

    if (scrapeUrl) {
      console.log(`\n📄 IG SCRAPE: ${scrapeUrl}`);
      const scraped = await scrapeInstagramPage(scrapeUrl, media, count, viralOnly);
      return res.json({
        success: true,
        source: 'scrape',
        scrapeUrl,
        media,
        count: scraped.length,
        fresh: true,
        data: scraped,
      });
    }

    if (!query) return res.status(400).json({ success: false, error: 'Missing ?q parameter (or use ?scrape=URL)' });

    console.log(`\n🔍 IG SEARCH: "${query}" (media: ${media}, count: ${count})`);
    const content = await searchInstagram(query, media, count);

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

    let followed = [];
    if (shouldFollow) {
      followed = await followRelatedAccounts(query, Math.min(count, 5));
    }

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
      fresh: true,
      data,
      followed: shouldFollow ? { count: followed.length, accounts: followed } : undefined,
      explore: shouldExplore ? { count: exploreContent.length, data: exploreContent } : undefined,
    });

  } catch (err) {
    console.error('Search endpoint error:', err.message);
    res.json({ success: true, count: 0, data: [] });
  }
});

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
      fresh: true,
      data: scraped,
    });
  } catch (err) {
    console.error('Scrape endpoint error:', err.message);
    res.json({ success: true, count: 0, data: [] });
  }
});

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

    res.json({ success: true, count: data.length, fresh: true, data });
  } catch (err) {
    res.json({ success: true, count: 0, data: [] });
  }
});

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

app.get('/', (req, res) => {
  res.json({
    status: 'alive',
    name: 'Instagram Marketing API',
    version: '1.1.0',
    loggedIn,
    freshSystem: true,
    seenPostsCache: seenIds.size,
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
      login_reset: 'GET /api/instagram/login — force re-login if session expired',
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
  console.log(`║   Instagram Marketing API v1.1      ║`);
  console.log(`║   Freshness system ACTIVE            ║`);
  console.log(`║   Port: ${PORT}                            ║`);
  console.log(`╚══════════════════════════════════════╝\n`);

  if (IG_USERNAME && IG_PASSWORD) {
    await loginToInstagram();
  } else {
    console.log('⚠️  Set IG_USERNAME & IG_PASSWORD in Render env vars\n');
  }
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

// ── Login Reset Endpoint ──
// GET /api/instagram/login — force re-login manually

app.get('/api/instagram/login', async (req, res) => {
  loggedIn = false;
  const result = await loginToInstagram();
  res.json({ success: result, loggedIn });
});
