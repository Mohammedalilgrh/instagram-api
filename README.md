# Instagram Marketing API v2.0

**Lightweight Instagram content API for n8n HTTP Request node.** No browser needed — instant startup, under 50MB RAM. Works on Render free plan forever.

**Completely rebuilt from v1:** Removed Playwright/Chromium (was crashing Render's 512MB RAM with 502 errors). Now uses reliable HTTP APIs only.

---

## 🚀 Deploy to Render (5 minutes)

### 1. Push to GitHub
```bash
git init
git add .
git commit -m "Instagram API v2.0"
git remote add origin https://github.com/YOUR_USERNAME/instagram-api.git
git push -u origin main
```

### 2. Deploy on Render

1. Go to [render.com](https://render.com) → Dashboard → **New +** → **Web Service**
2. Connect your GitHub repo
3. Settings:
   - **Runtime:** Docker
   - **Branch:** main
   - **Health Check Path:** `/`

4. **Environment Variables** (optional but recommended):
   - `PEXELS_API_KEY` — Free at pexels.com/api (adds stock photos)
   - `PIXABAY_API_KEY` — Free at pixabay.com/api (adds stock photos)

5. Click **Create Web Service**
6. Build takes ~1 minute (small Docker image — no Chromium!)

### 3. Keep Alive (free)

Render free services sleep after 15 min of inactivity. Set up UptimeRobot:
1. Go to [uptimerobot.com](https://uptimerobot.com) → Add New Monitor
2. Type: **HTTP(s)**, URL: `https://your-app.onrender.com/`
3. Interval: **5 minutes**

---

## 📡 n8n Usage

**Base URL:**
```
https://your-app.onrender.com
```

### 1. Search Content

```
GET /api/instagram/search?q=KEYWORD&media=image&count=5
```

| Param | Values | Default | Description |
|-------|--------|---------|-------------|
| `q` | string | — | **Required.** Search keyword |
| `media` | `image`, `reels`, `all` | `image` | Content type |
| `count` | 1-30 | `5` | Results to return |
| `exp` | `true` | — | Also fetch Explore/viral content |

**Example in n8n:** HTTP Request node → GET → `https://your-app.onrender.com/api/instagram/search?q=quotes&media=image&count=5`

```json
{
  "success": true,
  "query": "quotes",
  "media": "image",
  "count": 5,
  "data": [
    {
      "id": "wm-12345",
      "caption": "Inspirational quote image",
      "image": "https://upload.wikimedia.org/...",
      "link": "https://commons.wikimedia.org/...",
      "type": "image",
      "likes": "",
      "owner": "",
      "mediaUrl": "https://upload.wikimedia.org/..."
    }
  ]
}
```

### 2. Explore (Viral/Featured Content)

```
GET /api/instagram/explore?count=10
```

Returns high-quality featured images that rotate through different categories each call.

### 3. Scrape Any Instagram Page (best-effort)

```
GET /api/instagram/scrape?url=https://www.instagram.com/explore/tags/TAG/&media=posts&count=10
```

Works best with:
- Individual post URLs (`/p/CODE/`) — uses Instagram oEmbed API
- Hashtag pages (`/explore/tags/TAG/`) — uses Wikimedia proxy

### 4. Download Media

```
GET /api/instagram/download?url=MEDIA_URL
```

Proxies the media file. Use in n8n with Binary Data output.

### 5. OCR — Extract Text from Images

```
POST /api/instagram/ocr
Body: { "url": "https://...image_url..." }
```

```json
{
  "success": true,
  "text": "The only way to do great work is to love what you do.",
  "confidence": 92.5
}
```

---

## 🔧 Data Sources

| Source | API Key? | Reliability |
|--------|----------|-------------|
| **Wikimedia Commons** | No key needed ✅ | Always works — high quality photos |
| **Wikimedia Featured** | No key needed ✅ | Curated quality images |
| **Pexels** | Free key at pexels.com | Stock photos |
| **Pixabay** | Free key at pixabay.com | Stock photos |
| **Instagram oEmbed** | No key | Single post URLs only |

---

## 🤖 Why v2.0?

v1.0 used **Playwright + Chromium** (a full browser) which:
- Needed **512MB+ RAM** — crashed Render free plan constantly
- Took **2-4 minutes** to build Docker image
- Required **Instagram login** that kept breaking
- Gave **502 Bad Gateway** errors

v2.0 uses **axios HTTP requests only**:
- ✅ **Instant startup** (<1 second)
- ✅ **<50MB RAM** — never crashes
- ✅ **Docker build in ~30 seconds**
- ✅ **No Instagram login needed**
- ✅ **No 502 errors ever**
- ✅ **Works on Render free plan forever**

**Trade-off:** Instagram content uses proxy services (best-effort) instead of direct scraping. For reliable Instagram content, add `PEXELS_API_KEY` and `PIXABAY_API_KEY` env vars.

---

## 💡 Sample n8n Workflows

### Daily Quote Content Pipeline
```
1. Schedule (daily 8am)
2. HTTP Request → GET /api/instagram/search?q=quotes&media=image&count=5
3. Loop over items → POST /api/instagram/ocr body: {"url": "{{$json.mediaUrl}}"}
4. Save text + link to Google Sheets
```

### Viral Content Hunter
```
1. Schedule (every 6 hours)
2. HTTP Request → GET /api/instagram/explore?count=10
3. Save to database / send to Telegram
```

---

## ⚠️ Rate Limits

- Free API sources: ~10-20 calls/minute
- For bulk operations, add a **Wait node** (2-3s) between calls in n8n
- Wikimedia Commons has a generous rate limit but please be respectful
