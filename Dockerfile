# Build Stage
FROM node:latest AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

RUN npm run build

# Production Stage
FROM node:slim AS production

WORKDIR /app

COPY --from=build /app/dist ./dist
COPY --from=build /app/version.json ./version.json
COPY --from=build /app/node_modules ./node_modules
COPY package*.json ./

RUN apt-get update && apt-get -y upgrade && \
    npm prune --omit=dev && \
    mkdir -p /app/data && \
    chown -R node:node /app && \
    rm -rf /var/lib/apt/lists/*

VOLUME ["/app/data"]

USER node

CMD ["node", "dist/index.js"]
