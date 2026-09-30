# Abyss dive planner — PWA + Node API in one stateless container.
# All accounts/logbooks live in PostgreSQL (on AegisMesh: postgres-ha:5000).
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY . .
RUN chown -R node:node /app
USER node

ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz > /dev/null || exit 1

# node is PID 1 and handles SIGTERM itself (closes SSE streams, HTTP server, DB pool)
CMD ["node", "server/server.js"]
