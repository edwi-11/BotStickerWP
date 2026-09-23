FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY python/requirements.txt ./python/requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r python/requirements.txt

COPY . .

RUN useradd -m bot \
    && mkdir -p /srv/auth /srv/temp \
    && chown -R bot:bot /srv
USER bot

CMD ["node", "index.js"]
