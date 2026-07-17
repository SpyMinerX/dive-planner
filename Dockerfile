# Abyss dive planner — PWA + zero-dependency Node API in one container.
FROM node:22-alpine

WORKDIR /app
COPY . .

# run as the unprivileged node user; data lives in a volume
RUN mkdir -p /app/server/data && chown -R node:node /app
USER node

ENV PORT=8080
EXPOSE 8080
VOLUME /app/server/data

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/index.html > /dev/null || exit 1

CMD ["node", "server/server.js"]
