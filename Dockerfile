# Node-only, slimmer image
FROM node:20-bookworm

WORKDIR /app

# Keep ca-certificates for TLS
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install node deps
COPY package*.json ./
RUN npm ci --omit=dev

# App code
COPY . .

# Start the worker loop
CMD ["node", "cron/weeklyGenerator.js"]
