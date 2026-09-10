FROM oven/bun:1.2.21-alpine

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/usage.sqlite

RUN mkdir -p /data && chown -R bun:bun /app /data
USER bun

EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "const r=await fetch('http://127.0.0.1:3000/api/health');if(!r.ok)process.exit(1)"

CMD ["bun", "run", "src/server.ts"]
