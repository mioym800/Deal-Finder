# Use Debian-based Node so we can apt-get Chrome deps
FROM node:20-bullseye

# Puppeteer/Chromium dependencies
RUN apt-get update && apt-get install -y \
    ca-certificates fonts-liberation libasound2 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 libx11-6 libx11-xcb1 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libxrender1 libxshmfence1 \
    wget xdg-utils \
  && rm -rf /var/lib/apt/lists/*

# App
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Environment (PORT defaults in your code to 3015)
ENV NODE_ENV=production

# Health check (optional)
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
 CMD node -e "fetch('http://localhost:3015/api').then(()=>process.exit(0)).catch(()=>process.exit(1))" || exit 1

EXPOSE 3015
CMD ["node", "server.js"]