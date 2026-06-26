# Build Stage
FROM node:latest AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

RUN npm run build

# Production Stage
FROM node:bullseye-slim AS production

WORKDIR /app

COPY --from=build /app/dist ./dist
COPY --from=build /app/version.json ./version.json
COPY package*.json ./

RUN apt-get update && apt-get -y upgrade && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    npm install --production && \
    apt-get purge -y --auto-remove python3 make g++ && \
    rm -rf /var/lib/apt/lists/* && \
    mkdir -p /app/data && \
    chown -R node:node /app

VOLUME ["/app/data"]

USER node

CMD ["node", "dist/index.js"]
