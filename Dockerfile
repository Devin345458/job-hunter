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

# Chromium plus its system libraries, at exactly the version the lockfile pins. The build output
# only carries the playwright-core files the server imports, so the installer CLI comes from the
# builder's full node_modules.
COPY --from=builder /app/node_modules/playwright-core /opt/playwright-core
RUN node /opt/playwright-core/cli.js install --with-deps chromium \
  && rm -rf /var/lib/apt/lists/*

# Go toolchain for demo projects that close a Go requirement gap (server/utils/demo). Same
# Debian release as this image. Build commands set their own GOPATH and GOCACHE under /app/data.
COPY --from=golang:1.27-bookworm /usr/local/go /usr/local/go
ENV PATH=/usr/local/go/bin:$PATH

# Unprivileged user for model-chosen demo build commands (server/utils/demo/exec.ts).
RUN useradd --system --uid 10001 --user-group --create-home --shell /usr/sbin/nologin demo

RUN mkdir -p /app/data /app/data/resumes

ENV NODE_ENV=production
ENV TZ=America/Chicago
ENV NUXT_DATABASE_PATH=/app/data/job-hunter.db
ENV HOST=0.0.0.0
ENV PORT=3000

EXPOSE 3000

CMD ["node", ".output/server/index.mjs"]
