# Cloud Run image for the Waiting for Godot orchestrator service.
# In production, Firebase Hosting serves /waitingforgodot/** and /wfg/**
# from waiting-for-godot/web/ — this image only ships the API server.

FROM node:20-alpine

WORKDIR /app

# Install runtime dependencies with the lockfile for reproducibility.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Application source.
COPY src ./src

# Cloud Run sets PORT=8080 by default; config.js honours it.
ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "src/index.js"]
