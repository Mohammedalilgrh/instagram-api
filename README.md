# Instagram Marketing API v2.0

**100% real Instagram content API for n8n HTTP Request node.** Uses Playwright to log into your Instagram account and scrape real posts. No fake data, no fallbacks.

## 🧠 How It Works

1. **Instagram Login** — Your Instagram account logs in via Playwright browser automation
2. **Cookie Persistence** — Session is saved and reused across restarts
3. **Search & Explore** — Browser-based content extraction (no official API needed)
4. **Free Hosting** — Runs on Render free plan (Docker + Chromium)

## 🚀 Quick Deploy (Render)

### 1. Click Deploy

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Mohammedalilgrh/instagram-api)

*Or manually:*
- New → **Web Service**
- Connect your GitHub repo
- Runtime: **Docker**
- Branch: main

### 2. Set Environment Variables

| Variable | Value | Example |
|----------|-------|---------|
| `IG_USERNAME` | Your Instagram username | `my_marketing_acct` |
| `IG_PASSWORD` | Your Instagram password | `your_password` |

### 3. Set Health Check (optional)

- Settings → Health Check Path: `/`
- Prevents Render from restarting unnecessarily

### 4. Deploy

Click **Create Web Service**. First build takes 2-4 minutes (installing Chromium).

### 5. Keep Alive (UptimeRobot)

Render free services sleep after 15 minutes of inactivity. Set up UptimeRobot:

1. Go to [uptimerobot.com](https://uptimerobot.com) → Add New Monitor
2. Monitor Type: **HTTP(s)**
3. URL: `https://your-app.onrender.com/`
4. Interval: **5 minutes**
5. Click **Create Monitor**

---

## 📡 n8n HTTP Request Node Usage

### 📍 Endpoint Base URL

```
https://your-app.onrender.com
```

### ⭐ MAIN ENDPOINT: Viral Quotes with Auto-OCR Text Extraction

**This is the endpoint you should use.** It:
1. **Rotates through 50 different quote hashtags** — every call gets different content from different niches (quotes, motivation, inspiration, success, wisdom, life, goals, etc.)
2. **Opens each post individually** to extract clean media URLs (no ugly long video URLs)
3. **Auto-extracts text via OCR** — every result gets `ocr_text` and `ocr_confidence` so you get the quote as readable text
4. **Dedup cache** (`seen_ids.json`) — never returns the same post twice, ever
5. **Freshness guarantee** — call it 1000 times, get 1000 different results

**Method:** GET
**URL:** `/api/instagram/viral-quotes`

| Parameter | Type | Description | Default |
|-----------|------|-------------|---------|
| `count` | number | Number of quotes to return (1-10) | `3` |

**n8n setup:**
- Method: GET
- URL: `https://your-app.onrender.com/api/instagram/viral-quotes?count=5`
- Authentication: None
- Response format: JSON

**Response:**
```json
{
  "success": true,
  "count": 3,
  "data": [
    {
      "id": "DHxYkZ...",
      "image": "https://...cdninstagram.com/...",
      "link": "https://www.instagram.com/p/DHxYkZ...",
      "type": "image",
      "caption": "Believe in yourself... #quote",
      "ocr_text": "The only way to do great work is to love what you do.",
      "ocr_confidence": 92
    },
    {
      "id": "DHyAbC...",
      "image": "https://...cdninstagram.com/...",
      "link": "https://www.instagram.com/reel/DHyAbC...",
      "type": "reel",
      "caption": "Success is not final... #motivation",
      "ocr_text": "Success is not final, failure is not fatal: it is the courage to continue that counts.",
      "ocr_confidence": 88
    }
  ]
}
```

**n8n Workflow — Auto-Post Quotes to Google Sheets:**
1. Schedule (daily)
2. HTTP Request → GET `/api/instagram/viral-quotes?count=5`
3. Loop over each item in `data`
4. Extract `ocr_text`, `image`, `link` from each
5. Save to Google Sheets: quote_text | image_url | post_link

---

### 1. Search Content (Main Endpoint)

**Method:** GET
**URL:** `/api/instagram/search`

| Parameter | Type | Description | Default |
|-----------|------|-------------|---------|
| `q` | string | **Required** — search keyword | — |
| `media` | string | `image`, `reels`, or `all` | `image` |
| `count` | number | Results to return (1-30) | `5` |
| `follow` | string | `true` to follow niche accounts | — |
| `exp` | string | `true` to also fetch Explore page | — |

**🆕 Freshness system built-in:** Every call uses:
- **Auto-rotating word pool** (50 words) — appends a different tag each time
- **Dedup cache** (`seen_ids.json`) — never returns the same post twice, even across restarts
- **Cache-busting** — unique timestamp on every URL so Instagram serves fresh results

> ✅ Call it 100 times, get 100 different result sets. No repeats.

**Example — Search images with quotes:**

```
GET https://your-app.onrender.com/api/instagram/search?q=quotes&media=image&count=5
```

**n8n setup:**
- Method: GET
- Authentication: None
- Response format: JSON

**Response:**
```json
{
  "success": true,
  "query": "quotes",
  "media": "image",
  "count": 5,
  "data": [
    {
      "id": "DHxYkZ...",
      "caption": "Believe in yourself... #quote",
      "image": "https://...cdninstagram.com/...",
      "link": "https://www.instagram.com/p/DHxYkZ...",
      "type": "image",
      "likes": "12,345 likes",
      "views": "",
      "mediaUrl": "https://...cdninstagram.com/...",
      "owner": "quotegram"
    }
  ]
}
```

---

### 2. Search Reels (Viral Video Content)

```
GET https://your-app.onrender.com/api/instagram/search?q=quotes&media=reels&count=5
```

Returns reel data with video URLs, views, and captions.

**Response:**
```json
{
  "success": true,
  "query": "quotes",
  "media": "reels",
  "count": 5,
  "data": [
    {
      "id": "DHxYkZ...",
      "caption": "When they say... #motivation",
      "thumbnail": "https://...cdninstagram.com/...",
      "videoUrl": "https://...fbcdn.net/...",
      "link": "https://www.instagram.com/reel/DHxYkZ...",
      "type": "reel",
      "likes": "",
      "views": "45.6K views",
      "mediaUrl": "https://...fbcdn.net/...",
      "owner": "motivation_daily"
    }
  ]
}
```

---

### 3. Full Marketing Mode (Search + Follow + Explore)

This is the **main feature** — one request that:
1. Searches for your niche content
2. Follows big accounts in that niche (trains your Explore page)
3. Fetches viral content from Explore

```
GET https://your-app.onrender.com/api/instagram/search?q=quotes&media=all&count=5&follow=true&exp=true
```

**Response includes extra fields:**
```json
{
  "success": true,
  "query": "quotes",
  "media": "all",
  "count": 5,
  "data": [ ... ],
  "followed": {
    "count": 3,
    "accounts": ["quotesdaily", "motivationhub", "quoteoftheday"]
  },
  "explore": {
    "count": 10,
    "data": [
      {
        "id": "EXP123...",
        "caption": "Viral post from Explore...",
        "image": "https://...",
        "mediaUrl": "https://...",
        "likes": "89.2K likes",
        "views": "1.2M views",
        "link": "https://www.instagram.com/p/...",
        "owner": "viral_account"
      }
    ]
  }
}
```

**Marketing strategy:**
1. Create a fresh Instagram account
2. Set it to follow accounts in your niche using `follow=true`
3. Over time, the Explore page shows only niche-relevant content
4. Use `exp=true` to pull viral content daily

---

### 4. Explore Only

```
GET https://your-app.onrender.com/api/instagram/explore?count=10
```

Returns current viral content from Explore page — what Instagram recommends.

---

### 5. Follow Accounts

```
GET https://your-app.onrender.com/api/instagram/follow?q=quotes&count=5
```

OR (POST with JSON body):

```
POST https://your-app.onrender.com/api/instagram/follow
Body: { "q": "quotes", "count": 5 }
```

Follows accounts matching your niche. Use this daily to train the algorithm.

---

### 6. Download Media

```
GET https://your-app.onrender.com/api/instagram/download?url=MEDIA_URL
```

Proxies the media file (image/video). Use in n8n with Binary Data output.

---

### 7. OCR — Extract Text from Images/Reels

```
POST https://your-app.onrender.com/api/instagram/ocr
Body: { "url": "https://...image_url..." }
```

**Response:**
```json
{
  "success": true,
  "text": "The only way to do great work is to love what you do. — Steve Jobs",
  "confidence": 92.5
}
```

**n8n example:**
1. HTTP Request → search for content
2. Extract `image` / `mediaUrl` from each result
3. Loop through each → HTTP Request (POST OCR endpoint)
4. Extract `text` from OCR response → use in your workflow

---

### 8. Scrape Any Instagram Page (Profile, Hashtag, etc.)

Scrape ALL content from any Instagram page — a profile, a hashtag feed, a specific account's reels.

**Two equivalent ways:**

```
# Via the search endpoint with ?scrape=
GET /api/instagram/search?scrape=https://www.instagram.com/nike/&media=posts&count=10

# Via the dedicated scrape endpoint
GET /api/instagram/scrape?url=https://www.instagram.com/nike/&media=reels&count=5&viral=true
```

| Parameter | Type | Description | Default |
|-----------|------|-------------|---------|
| `scrape` / `url` | string | **Required** — full Instagram page URL | — |
| `media` | string | `posts` or `reels` | `posts` |
| `count` | number | Results to return (1-30) | `5` |
| `viral` | string | `true` to rank by highest engagement | — |

**Example — scrape all posts from a big account:**

```
GET /api/instagram/search?scrape=https://www.instagram.com/nike/&media=posts&count=10
```

**Example — scrape reels with viral ranking:**

```
GET /api/instagram/search?scrape=https://www.instagram.com/nike/&media=reels&count=5&viral=true
```

When `viral=true` it:
1. Scrolls deeper to collect more content
2. Opens each post to get likes/views
3. Returns results sorted by engagement (highest first)

**Response:**
```json
{
  "success": true,
  "source": "scrape",
  "scrapeUrl": "https://www.instagram.com/nike/",
  "media": "posts",
  "count": 10,
  "data": [
    {
      "id": "DHxYkZ...",
      "caption": "Just do it...",
      "image": "https://...cdninstagram.com/...",
      "link": "https://www.instagram.com/p/DHxYkZ...",
      "type": "post",
      "likes": "89,201 likes",
      "views": "",
      "mediaUrl": "https://...cdninstagram.com/...",
      "owner": "",
      "engagement": 89201
    }
  ]
}
```

**Use cases:**
- **Competitor research** — scrape a competitor's profile, see which posts get the most engagement
- **Influencer analysis** — scrape an influencer's page, find their best-performing content
- **Hashtag research** — scrape `https://www.instagram.com/explore/tags/motivation/`
- **Trend spotting** — scrape a niche account daily, track which posts are outperforming
- **Content curation** — scrape accounts in your niche and use the content for inspiration
- **Viral sorting** — `viral=true` finds the hidden gems (posts with highest engagement)<｜end▁of▁thinking｜>

---

## ⚠️ Important Notes

### Rate Limiting
- Instagram has rate limits. Do NOT call more than once per minute.
- For bulk operations, add a **Wait node** (60s) between calls in n8n.

### Session Expiry
- Instagram sessions last 1-2 weeks.
- The API auto-logins on restart if cookies are expired.
- If you get errors, restart the service on Render.

### Follow Limits
- Instagram limits ~20-30 follows per hour for new accounts.
- The API respects safe limits. Don't use `count` > 5 per call.

### Explore Training
- New accounts show generic Explore content.
- Use `follow=true` for 1-2 weeks daily to train the algorithm.
- After training, Explore content becomes niche-specific.

---

## 📂 Local Testing

```bash
# Clone
git clone https://github.com/Mohammedalilgrh/instagram-api.git
cd instagram-api

# Install + test
npm install
npx playwright install chromium

# Set credentials and run
set IG_USERNAME=your_username
set IG_PASSWORD=your_password
npm start
```

Then visit: `http://localhost:3000/`

---

## 🛠 Troubleshooting

| Problem | Solution |
|---------|----------|
| `Login failed` | Check IG_USERNAME/IG_PASSWORD env vars. Try logging in manually first. |
| `Empty results` | Instagram may show login wall. Ensure the account is logged in. |
| `Session expired` | Restart the Render web service (manual deploy or restart). |
| `Follow not working` | New accounts have stricter follow limits. Wait 24h. |
| `502 Bad Gateway` | Render is booting. Wait 30s and retry. |
| `Build fails` | Check Render logs. Ensure Dockerfile is in root. |

---

## 📊 Sample n8n Workflows

### Workflow 1: Daily Quote Content Pipeline
```
1. Schedule (daily 8am)
2. HTTP Request → GET /api/instagram/search?q=quotes&media=all&count=3&follow=true
3. Extract "data" items
4. Loop over items:
   5. HTTP Request → POST /api/instagram/ocr  body: {"url": "{{$json.mediaUrl}}"}
   6. Save text + link to Google Sheets / Notion / file
```

### Workflow 2: Competitor Research (Scrape)
```
1. Manual Trigger
2. HTTP Request → GET /api/instagram/scrape?url=https://www.instagram.com/COMPETITOR_USERNAME/&media=posts&count=20&viral=true
3. Items are already sorted by engagement (highest first)
4. Loop over top 5:
   5. Extract caption, likes, mediaUrl, link
   6. Save to Google Sheets: caption | likes | link | mediaUrl
```

### Workflow 3: Viral Reels Hunter
```
1. Schedule (every 6 hours)
2. HTTP Request → GET /api/instagram/scrape?url=https://www.instagram.com/BIG_ACCOUNT_IN_NICHE/&media=reels&count=10&viral=true
3. Filter items with engagement > 10,000
4. Send to Telegram / Slack: "🔥 Viral reel: {{caption}} ({{likes}})"
5. Save to database for trend tracking
```

### Workflow 4: Full Niche Training + Scrape + Explore
```
1. Schedule (daily)
2. HTTP Request → GET /api/instagram/search?q=YOUR_NICHE&media=all&count=3&follow=true&exp=true
   → Follows niche accounts, gets explore content
3. For each followed account:
   4. HTTP Request → GET /api/instagram/scrape?url=https://www.instagram.com/{{username}}/&media=posts&count=5&viral=true
   5. Save best content from each account
6. Send daily summary: "🎯 Followed X accounts | Collected Y viral posts"
```

Built for marketers, content creators, and n8n power users.
