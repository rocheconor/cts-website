# Cloud Run image for panelchat. Ships the orchestrator API server plus
# the static web assets under web/. Build context is panelchat/ (one level
# above server/) so this Dockerfile can COPY both server/ and web/.

FROM node:20-alpine

WORKDIR /app

# Install server runtime dependencies first (lockfile for reproducibility).
COPY server/package.json server/package-lock.json ./server/
WORKDIR /app/server
RUN npm ci --omit=dev && npm cache clean --force

# Server source.
WORKDIR /app
COPY server/src ./server/src

# Static web assets — served by Cloud Run when no upstream (Firebase
# Hosting) is in front of it.
COPY web ./web

ENV NODE_ENV=production
EXPOSE 8080
WORKDIR /app/server
CMD ["node", "src/index.js"]
