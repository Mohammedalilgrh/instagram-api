# ─────────────────────────────────────────────
# Instagram Marketing API – Render (Docker)
# ─────────────────────────────────────────────
FROM node:20-slim

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0 \
    libwayland-client0 libwayland-egl1 \
    fonts-freefont-ttf \
    --no-install-recommends && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

# Install FULL Chromium (not headless shell) — stealth makes it undetectable
RUN npx playwright install --with-deps chromium

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
