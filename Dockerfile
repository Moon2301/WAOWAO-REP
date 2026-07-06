# ==================== Stage 1: Dependencies ====================
FROM node:20-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN --mount=type=cache,target=/root/.npm npm install --ignore-scripts && npx prisma generate

# ==================== Stage 2: Build ====================
FROM node:20-alpine AS builder
WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Prisma generate + Next.js build (standalone output)
# Cache mount giữ .next/cache giữa các lần build → chỉ compile phần thay đổi
RUN --mount=type=cache,target=/app/.next/cache npm run build

# ==================== Stage 3: Production dependencies only ====================
FROM node:20-alpine AS prod-deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN --mount=type=cache,target=/root/.npm npm install --omit=dev --ignore-scripts && npx prisma generate

# ==================== Stage 4: Production ====================
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# Install tini for proper signal handling + ffmpeg
RUN apk add --no-cache tini ffmpeg

# --- Production-only node_modules (much smaller, no devDeps) ---
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# --- Standalone Next.js server ---
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# --- Prisma schema (db push needs it) ---
COPY --from=builder /app/prisma ./prisma

# --- Worker / Watchdog / Bull Board source + configs ---
COPY --from=builder /app/src ./src
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/standards ./standards
COPY --from=builder /app/messages ./messages
COPY --from=builder /app/tsconfig.json ./tsconfig.json

# Runtime log dir + empty .env (tsx --env-file=.env needs the file to exist)
RUN mkdir -p /app/logs && touch /app/.env

EXPOSE 3000 3010

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["npm", "run", "start:docker"]
