FROM node:22-bookworm AS deps

WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:22-bookworm AS build

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm AS runtime

WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/database/migrations ./dist/database/migrations

CMD ["node", "dist/main.js"]
