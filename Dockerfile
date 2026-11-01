# Debian, not Alpine: Playwright's Chromium needs glibc, and better-sqlite3 must be compiled
# against the same libc it runs on, so builder and runner share one base image.
FROM node:22-bookworm-slim AS base
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app

FROM base AS builder
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM base AS runner
ARG SOURCE_COMMIT=""
ENV SOURCE_COMMIT=${SOURCE_COMMIT}
RUN apt-get update \
  && apt-get install -y --no-install-recommends git sqlite3 ca-certificates tzdata openssh-client \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/.output ./.output
COPY --from=builder /app/server/db/migrations ./server/db/migrations
COPY --from=builder /app/scripts ./scripts

# Chromium plus its system libraries, at exactly the version the bundled playwright-core expects.
RUN node .output/server/node_modules/playwright-core/cli.js install --with-deps chromium \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /app/data /app/data/resumes

ENV NODE_ENV=production
ENV TZ=America/Chicago
ENV NUXT_DATABASE_PATH=/app/data/job-hunter.db
ENV HOST=0.0.0.0
ENV PORT=3000

EXPOSE 3000

CMD ["node", ".output/server/index.mjs"]
