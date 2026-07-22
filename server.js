const express = require('express');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);
const { createWorker } = require('tesseract.js');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const IG_USERNAME = process.env.IG_USERNAME || '';
const IG_PASSWORD = process.env.IG_PASSWORD || '';
const CAPSOLVER_KEY = process.env.CAPSOLVER_API_KEY || '';
const STATE_FILE = path.join(__dirname, 'instagram_auth.json');
const DEDUP_FILE = path.join(__dirname, 'seen_ids.json');

app.use(cors());
app.use(express.json({ limit: '5mb' }));

let loggedIn = false;

// ─── 50 Quote Hashtags (rotation) ───────────
const QUOTE_TAGS = [
  'quotes','motivation','inspiration','success','mindset','wisdom','life','love',
  'happiness','goals','dreams','focus','positive','attitude','discipline','growth',
  'faith','hope','courage','strength','power','truth','purpose','passion','vision',
  'believe','achieve','inspire','grind','rise','shine','determination','persistence',
  'excellence','leadership','wisewords','dailymotivation','motivationalquotes',
  'inspirationalquotes','quotestoliveby','lifequotes','quoteoftheday','dailyquote',
  'motivationdaily','successmindset','nevergiveup','stayfocused','beyourself',
  'thinkbig','positivevibes','goodvibes','motivational','quote','wisdomquotes',
];
let tagIndex = 0;

// ─── CapSolver ───────────────────────────────
async function solveRecaptcha(page) {
  if (!CAPSOLVER_KEY) return false;
  try {
    const sitekey = await page.evaluate(() =>
      document.querySelector('.g-recaptcha')?.getAttribute('data-sitekey') ||
      document.querySelector('[data-sitekey]')?.getAttribute('data-sitekey') || ''
    );
    if (!sitekey) return false;
    const url = page.url();
    const taskRes = await fetch('https://api.capsolver.com/createTask', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: CAPSOLVER_KEY, task: { type: 'ReCaptchaV2Task', websiteURL: url, websiteKey: sitekey, isInvisible: false } }),
    });
    const taskData = await taskRes.json();
    if (taskData.errorId) return false;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const r = await fetch('https://api.capsolver.com/getTaskResult', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: CAPSOLVER_KEY, taskId: taskData.taskId }),
      });
      const d = await r.json();
      if (d.status === 'ready') {
        const token = d.solution?.gRecaptchaResponse;
        if (!token) return false;
        await page.evaluate((t) => {
          let ta = document.getElementById('g-recaptcha-response');
          if (!ta) { ta = document.createElement('textarea'); ta.id = 'g-recaptcha-response'; document.body.appendChild(ta); }
          ta.textContent = t;
        }, token);
        return true;
      }
    }
    return false;
  } catch (e) { return false; }
}

// ─── Dedup ─────────────────────────────────────
let seenIds = new Set();
if (fs.existsSync(DEDUP_FILE)) {
  try { seenIds = new Set(JSON.parse(fs.readFileSync(DEDUP_FILE, 'utf8'))); } catch(e) {}
}
function saveSeenIds() {
  if (seenIds.size > 5000) { const a=[...seenIds]; seenIds=new Set(a.slice(a.length-4000)); }
  fs.writeFileSync(DEDUP_FILE, JSON.stringify([...seenIds]));
}
function markSeen(id) { if(id){seenIds.add(id);saveSeenIds();} }
function isSeen(id) { return seenIds.has(id); }

let callCounter = Date.now();
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// ─── Auto-Retry Login ────────────────────────
let loginInProgress = false;
async function ensureLogin() {
  if (loggedIn) return true;
  if (fs.existsSync(STATE_FILE)) {
    try { const c = JSON.parse(fs.readFileSync(STATE_FILE,'utf8')); if (c?.length) { loggedIn=true; return true; } } catch(e) {}
  }
  if (!IG_USERNAME || !IG_PASSWORD) return false;
  if (loginInProgress) { while (loginInProgress) await new Promise(r=>setTimeout(r,2000)); return loggedIn; }
  loginInProgress = true;
  const result = await loginToInstagram();
  loginInProgress = false;
  return result;
}

// ─── Login ─────────────────────────────────────
async function loginToInstagram() {
  if (!IG_USERNAME || !IG_PASSWORD) return false;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled','--window-size=1920,1080'] });
    const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36', viewport: { width:1920, height:1080 }, locale:'en-US', timezoneId:'America/New_York' });
    const page = await context.newPage();
    await page.goto('https://www.instagram.com/accounts/login/', { waitUntil:'networkidle', timeout:45000 }).catch(()=>{});
    await page.waitForTimeout(5000);
    try { await page.waitForSelector('input[name="email"], input[name="username"]', { timeout:20000 }); } catch(e) { await page.waitForTimeout(5000); }
    try { const cb = page.locator('button:has-text("Allow"), button:has-text("Accept")').first(); await cb.click({timeout:3000}); } catch(e) {}
    let filled = false;
    for (const sel of ['input[name="email"]', 'input[name="username"]']) {
      try { const el = page.locator(sel).first(); if (await el.count()>0) { await el.fill(IG_USERNAME); filled=true; break; } } catch(e) {}
    }
    if (!filled) { try { const inputs=page.locator('input:not([type="hidden"])'); for(let i=0;i<await inputs.count();i++){const t=await inputs.nth(i).getAttribute('type');if(t==='text'||!t){await inputs.nth(i).fill(IG_USERNAME);filled=true;break;}} } catch(e) {} }
    await page.waitForTimeout(500);
    for (const sel of ['input[name="pass"]', 'input[name="password"]', 'input[type="password"]']) {
      try { const el=page.locator(sel).first(); if(await el.count()>0) { await el.fill(IG_PASSWORD); break; } } catch(e) {}
    }
    await page.waitForTimeout(500);
    try { const btn=page.locator('button[type="submit"], input[type="submit"]').first(); if(await btn.count()>0) await btn.click({timeout:5000,force:true}); } catch(e) {}
    await page.keyboard.press('Enter');
    await page.waitForTimeout(10000);
    let ok = !page.url().includes('accounts/login');
    if (!ok) { await page.waitForTimeout(8000); ok = !page.url().includes('accounts/login'); }
    if (!ok && page.url().includes('recaptcha')) { const s=await solveRecaptcha(page); if(s) { await page.waitForTimeout(10000); ok=!page.url().includes('accounts/login')&&!page.url().includes('recaptcha'); } }
    if (!ok) return false;
    try { await page.locator('button:has-text("Not Now")').first().click({timeout:3000}); } catch(e) {}
    const cookies = await context.cookies();
    fs.writeFileSync(STATE_FILE, JSON.stringify(cookies,null,2));
    loggedIn = true;
    console.log('✅ Instagram login successful!');
    await context.close(); await browser.close();
    return true;
  } catch(err) { console.error('Login error:', err.message?.substring(0,80)); if(browser) await browser.close().catch(()=>{}); return false; }
}

// ─── Browser Factory ───────────────────────────
async function createSession() {
  const browser = await chromium.launch({ headless:true, args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled','--window-size=1920,1080'] });
  const context = await browser.newContext({ userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36', viewport:{width:1920,height:1080}, locale:'en-US', timezoneId:'America/New_York' });
  await context.addInitScript(() => { Object.defineProperty(navigator,'webdriver',{get:()=>false}); Object.defineProperty(navigator,'plugins',{get:()=>[1,2,3,4,5]}); Object.defineProperty(navigator,'languages',{get:()=>['en-US','en']}); });
  if (fs.existsSync(STATE_FILE)) { try { const cookies=JSON.parse(fs.readFileSync(STATE_FILE,'utf8')); await context.addCookies(cookies); } catch(e) {} }
  return { browser, context };
}

let ocrWorker = null;
async function initOcr() {
  if (!ocrWorker) ocrWorker = await createWorker('eng');
  return ocrWorker;
}

// ─── Clean Media URL ──────────────────────────
function cleanMediaUrl(url) {
  if (!url) return '';
  // Extract the base CDN URL without query params for images
  if (url.includes('cdninstagram.com') && url.includes('?')) {
    return url.split('?')[0];
  }
  return url;
}

// ─── Open Post to Get Clean Media + OCR ──────
async function enrichPost(page, post) {
  try {
    await page.goto(post.link, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000);

    // Get clean image from the post page
    const media = await page.evaluate(() => {
      // Try to get the main image/video
      const imgs = document.querySelectorAll('img[decoding="auto"], img[src*="cdninstagram"]');
      for (const img of imgs) {
        if (img.src && img.src.includes('cdninstagram') && img.width > 100) {
          // Return clean URL without query params
          return img.src.split('?')[0];
        }
      }
      const videos = document.querySelectorAll('video');
      for (const v of videos) {
        if (v.src) return v.src;
      }
      return '';
    });

    if (media) post.image = cleanMediaUrl(media);

    // Get caption text from the post
    const caption = await page.evaluate(() => {
      // Try different caption selectors
      const el = document.querySelector('h1') ||
                 document.querySelector('[data-e2e="caption"]') ||
                 document.querySelector('article div span') ||
                 document.querySelector('div._a9zr');
      return el?.innerText?.substring(0, 500) || '';
    });
    if (caption) post.caption = caption;

    // Try OCR on the image if we have one
    if (post.image && post.image.length > 10) {
      try {
        await initOcr();
        // Use the clean image URL
        const { data } = await ocrWorker.recognize(post.image);
        if (data.text?.trim()) {
          post.ocr_text = data.text.trim().substring(0, 500);
          post.ocr_confidence = Math.round(data.confidence || 0);
        }
      } catch (e) {
        // OCR failed silently
      }
    }

    return post;
  } catch (e) {
    return post; // Return as-is if enrich fails
  }
}

// ─── Quote Tags with Rotation ─────────────────
function getNextTag() {
  const tag = QUOTE_TAGS[tagIndex % QUOTE_TAGS.length];
  tagIndex++;
  return tag;
}

function getNextTags(count) {
  const tags = [];
  for (let i = 0; i < count; i++) {
    tags.push(getNextTag());
  }
  return tags;
}

// ─── Fetch Viral Quotes ───────────────────────
async function fetchViralQuotes(limit = 3) {
  const maxRes = Math.min(limit, 10);
  const results = [];

  // Get 2-3 different hashtags to diversify results
  const tags = getNextTags(Math.min(3, maxRes + 1));

  try {
    await ensureLogin();
    const { browser, context } = await createSession();
    const page = await context.newPage();

    for (const tag of tags) {
      if (results.length >= maxRes) break;
      callCounter++;
      console.log(`🔍 #${tag}`);

      try {
        await page.goto(`https://www.instagram.com/explore/tags/${tag}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(4000);

        // Scroll a bit to load posts
        for (let s = 0; s < 6; s++) {
          await page.evaluate(() => window.scrollBy(0, 800));
          await page.waitForTimeout(1500);
        }

        // Collect fresh posts
        const rawPosts = await page.evaluate(() => {
          const items = [];
          const links = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
          for (const link of links) {
            const href = link.getAttribute('href');
            const isReel = href?.includes('/reel/');
            const id = href ? href.split(isReel ? '/reel/' : '/p/')[1]?.split('/')[0] || '' : '';
            if (!id) continue;

            const video = link.querySelector('video');
            const img = link.querySelector('img');
            const thumb = video?.src || img?.src || '';

            items.push({
              id, type: isReel ? 'reel' : 'image',
              image: cleanMediaUrl(thumb),
              link: `https://www.instagram.com${href}`,
            });
          }
          return items;
        });

        // Dedup and add
        for (const p of rawPosts) {
          if (results.length >= maxRes) break;
          if (!isSeen(p.id)) {
            markSeen(p.id);
            results.push(p);
          }
        }
      } catch (e) {
        console.log(`  ⚠️ #${tag} error: ${e.message?.substring(0,60)}`);
      }
    }

    await context.close();
    await browser.close();

    // Enrich each post with clean media + OCR
    if (results.length > 0) {
      console.log(`📸 Enriching ${results.length} posts with media + OCR...`);
      const { browser: b2, context: c2 } = await createSession();
      const p2 = await c2.newPage();

      for (let i = 0; i < results.length; i++) {
        console.log(`  📍 ${i+1}/${results.length}: ${results[i].id}`);
        results[i] = await enrichPost(p2, results[i]);
      }

      await c2.close();
      await b2.close();
    }

    console.log(`✅ ${results.length} viral quotes`);
    return results;

  } catch (err) {
    console.error('Viral quotes error:', err.message?.substring(0,80));
    return results;
  }
}

// ─── Routes ────────────────────────────────────

// ★ MAIN ENDPOINT: Get viral quotes with OCR text
app.get('/api/instagram/viral-quotes', async (req, res) => {
  try {
    const count = parseInt(req.query.count || '3', 10);
    if (!await ensureLogin()) {
      return res.json({ success: false, error: 'Not logged in' });
    }
    const quotes = await fetchViralQuotes(count);
    res.json({ success: true, count: quotes.length, data: quotes });
  } catch (err) {
    res.json({ success: false, error: err.message, data: [] });
  }
});

// Legacy endpoints (keep for backwards compat)
app.get('/api/instagram/search', async (req, res) => {
  try {
    const query = req.query.q || req.query.query;
    const count = parseInt(req.query.count || '5', 10);
    if (!await ensureLogin()) return res.json({ success: false, error: 'Not logged in' });
    if (!query) return res.status(400).json({ success: false, error: 'Missing ?q' });

    const { browser, context } = await createSession();
    const page = await context.newPage();
    callCounter++;
    const isSingle = /^[\w]+$/.test(query);
    const searchUrl = isSingle ? `https://www.instagram.com/explore/tags/${encodeURIComponent(query)}/` : `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(query)}`;
    await page.goto(searchUrl, { waitUntil:'domcontentloaded', timeout:25000 });
    await page.waitForTimeout(5000);
    for (let s=0; s<8; s++) { await page.evaluate(()=>window.scrollBy(0,1200)); await page.waitForTimeout(1500); }
    const posts = await page.evaluate((maxRes) => {
      const items=[], seen=new Set();
      const links=document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
      for (const link of links) {
        if (items.length>=maxRes) break;
        const href=link.getAttribute('href');
        const isReel=href?.includes('/reel/');
        const id=href?href.split(isReel?'/reel/':'/p/')[1]?.split('/')[0]||'':'';
        if (!id||seen.has(id)) continue; seen.add(id);
        const video=link.querySelector('video'); const img=link.querySelector('img');
        items.push({id, caption:img?.alt?.substring(0,300)||'', image:video?.src?.split('?')[0]||img?.src?.split('?')[0]||'', link:`https://www.instagram.com${href}`, type:isReel?'reel':'image' });
      }
      return items;
    }, count*2);
    await context.close(); await browser.close();
    const results=[];
    for (const r of posts) { if (results.length>=count) break; const k=r.id||r.link; if(k&&!isSeen(k)){markSeen(k);results.push(r);} }
    res.json({ success:true, query, count:results.length, data:results });
  } catch(err) { res.json({ success:false, error:err.message, data:[] }); }
});

app.get('/api/instagram/explore', async (req, res) => {
  try {
    const count = parseInt(req.query.count||'10',10);
    if (!await ensureLogin()) return res.json({ success: false, error: 'Not logged in' });
    const { browser, context } = await createSession();
    const page = await context.newPage();
    await page.goto('https://www.instagram.com/explore/', { waitUntil:'domcontentloaded', timeout:25000 });
    await page.waitForTimeout(5000);
    for (let s=0; s<8; s++) { await page.evaluate(()=>window.scrollBy(0,1200)); await page.waitForTimeout(1500); }
    const posts = await page.evaluate((maxRes) => {
      const items=[], seen=new Set(); const links=document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
      for (const link of links) { if(items.length>=maxRes)break; const href=link.getAttribute('href'); const isReel=href?.includes('/reel/'); const id=href?href.split(isReel?'/reel/':'/p/')[1]?.split('/')[0]||'':''; if(!id||seen.has(id))continue; seen.add(id); const video=link.querySelector('video'); const img=link.querySelector('img'); items.push({id, caption:img?.alt?.substring(0,300)||'', image:video?.src?.split('?')[0]||img?.src?.split('?')[0]||'', link:`https://www.instagram.com${href}`, type:isReel?'reel':'image'}); }
      return items;
    }, count*2);
    await context.close(); await browser.close();
    const results=[];
    for (const r of posts) { if(results.length>=count)break; const k=r.id||r.link; if(k&&!isSeen(k)){markSeen(k);results.push(r);} }
    res.json({ success:true, count:results.length, data:results });
  } catch(err) { res.json({ success:false, error:err.message, data:[] }); }
});

app.get('/api/instagram/scrape', async (req, res) => {
  try {
    const url = req.query.url||req.query.pageUrl||req.query.scrape;
    const count = parseInt(req.query.count||'10',10);
    if (!url) return res.status(400).json({ success:false, error:'Missing ?url' });
    if (!await ensureLogin()) return res.json({ success: false, error: 'Not logged in' });
    const { browser, context } = await createSession();
    const page = await context.newPage();
    await page.goto(url, { waitUntil:'domcontentloaded', timeout:25000 });
    await page.waitForTimeout(5000);
    for (let s=0; s<8; s++) { await page.evaluate(()=>window.scrollBy(0,1200)); await page.waitForTimeout(1500); }
    const posts = await page.evaluate((maxRes) => {
      const items=[], seen=new Set(); const links=document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
      for (const link of links) { if(items.length>=maxRes)break; const href=link.getAttribute('href'); const isReel=href?.includes('/reel/'); const id=href?href.split(isReel?'/reel/':'/p/')[1]?.split('/')[0]||'':''; if(!id||seen.has(id))continue; seen.add(id); const video=link.querySelector('video'); const img=link.querySelector('img'); items.push({id, caption:img?.alt?.substring(0,300)||'', image:video?.src?.split('?')[0]||img?.src?.split('?')[0]||'', link:`https://www.instagram.com${href}`, type:isReel?'reel':'image'}); }
      return items;
    }, count*2);
    await context.close(); await browser.close();
    const results=[];
    for (const r of posts) { if(results.length>=count)break; const k=r.id||r.link; if(k&&!isSeen(k)){markSeen(k);results.push(r);} }
    res.json({ success:true, scrapeUrl:url, count:results.length, data:results });
  } catch(err) { res.json({ success:false, error:err.message, data:[] }); }
});

app.get('/api/instagram/login', async (req, res) => {
  loggedIn = false;
  const result = await loginToInstagram();
  res.json({ success:result, loggedIn });
});

app.get('/api/instagram/download', async (req, res) => {
  try {
    const mediaUrl = req.query.url;
    if (!mediaUrl) return res.status(400).json({ success:false, error:'Missing ?url=' });
    https.get(mediaUrl, { headers:{'User-Agent':UA,'Referer':'https://www.instagram.com/'} }, (response) => {
      if (response.statusCode>=300&&response.statusCode<400&&response.headers.location) return res.redirect(response.headers.location);
      if (response.statusCode!==200) return res.status(500).json({ success:false, error:'Download failed' });
      res.setHeader('Content-Type', response.headers['content-type']||'image/jpeg');
      response.pipe(res);
    }).on('error', () => res.status(500).json({ success:false, error:'Download failed' }));
  } catch { res.status(500).json({ success:false, error:'Download failed' }); }
});

app.get('/api/instagram/session/export', (req, res) => {
  try { const data = fs.readFileSync(STATE_FILE,'utf8'); res.json({ success:true, session:JSON.parse(data) }); }
  catch { res.json({ success:false, error:'No session file' }); }
});

app.post('/api/instagram/session/import', async (req, res) => {
  try {
    const session = req.body?.session;
    if (!session||!Array.isArray(session)) return res.status(400).json({ success:false, error:'Missing "session" array' });
    fs.writeFileSync(STATE_FILE, JSON.stringify(session,null,2));
    loggedIn = true;
    res.json({ success:true, note:'Session imported!' });
  } catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

app.post('/api/instagram/ocr', async (req, res) => {
  try {
    const url = req.body?.url;
    if (!url) return res.status(400).json({ success:false, error:'Missing "url"' });
    await initOcr();
    const { data } = await ocrWorker.recognize(url);
    res.json({ success:true, text:data.text?.trim()||'', confidence:data.confidence||0 });
  } catch { res.status(500).json({ success:false, error:'OCR failed' }); }
});

app.get('/', (req, res) => {
  res.json({
    status:'alive', name:'Instagram API v2.0', version:'2.0.0', loggedIn,
    realInstagramOnly:true, seenPostsCache:seenIds.size,
    setup:loggedIn?'✅ Instagram logged in':'⚠️ Login required',
    quoteTagsRotation: QUOTE_TAGS.length,
    endpoints:{
      viralQuotes:'GET /api/instagram/viral-quotes?count=3 (★ RECOMMENDED - auto OCR)',
      search:'GET /api/instagram/search?q=KEYWORD&count=5',
      explore:'GET /api/instagram/explore?count=10',
      scrape:'GET /api/instagram/scrape?url=URL&count=10',
      download:'GET /api/instagram/download?url=URL',
      ocr:'POST /api/instagram/ocr {"url":"URL"}',
      sessionImport:'POST /api/instagram/session/import {"session":[...]}',
      sessionExport:'GET /api/instagram/session/export',
    },
  });
});

// ─── Start ─────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║  Instagram Marketing API v2.0       ║`);
  console.log(`║  ★ Viral Quotes + Auto OCR          ║`);
  console.log(`║  Port: ${PORT}                              ║`);
  console.log(`╚══════════════════════════════════════╝\n`);

  if (IG_USERNAME && IG_PASSWORD) {
    loginToInstagram().then(r => {
      if (r) console.log('✅ Initial login successful');
      else console.log('⚠️ Initial login failed — will retry on first API request');
    });
  } else {
    console.log('⚠️  Set IG_USERNAME & IG_PASSWORD in Render env vars');
  }
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
