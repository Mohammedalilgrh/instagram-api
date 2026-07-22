# Instagram Marketing API v1.0

**Full-featured Instagram API for n8n HTTP Request node.** Search content, get viral reels, follow niche accounts, extract text via OCR, and download media — all from a free Render web service.

## 🧠 How It Works

1. **Instagram Login** — Your Instagram account logs in via Playwright browser automation
2. **Cookie Persistence** — Session is saved and reused across restarts
3. **Search & Explore** — Browser-based content extraction (no official API needed)
4. **Niche Training** — Follow accounts in your niche to train Explore page
5. **Free Hosting** — Runs on Render free plan (Docker + Chromium)

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

## 📊 Sample n8n Workflow

```
1. Manual Trigger
2. HTTP Request → GET /api/instagram/search?q=quotes&media=all&count=3&follow=true
3. Extract "data" items
4. Loop over items:
   5. HTTP Request → POST /api/instagram/ocr  body: {"url": "{{$json.mediaUrl}}"}
   6. Save text + link to Google Sheets / Notion / file
```

---

Built for marketers, content creators, and n8n power users.
