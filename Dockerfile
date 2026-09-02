FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# ffmpeg 二进制由 @ffmpeg-installer 提供,standalone 产物不包含 node_modules 里的平台包,单独拷入
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@ffmpeg-installer/linux-x64 ./ffmpeg-bin
ENV FFMPEG_BINARY_PATH=/app/ffmpeg-bin/ffmpeg

# 数据目录(SQLite + 媒体 + 导出成片),运行时挂载卷持久化
RUN mkdir -p /app/data && chown -R nextjs:nodejs /app/data /app/ffmpeg-bin

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
