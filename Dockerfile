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
# The Claude Code binary the Agent SDK starts (server/utils/agent-backend.ts). It ships as the SDK's
# optional platform package (glibc build for this Debian image). The Nitro build does not trace it,
# since the SDK finds it at run time, so it is copied to a fixed path for the runner.
RUN mkdir -p /opt/claude-code \
  && cp "node_modules/@anthropic-ai/claude-agent-sdk-linux-$(node -p process.arch)/claude" /opt/claude-code/claude \
  && chmod 0755 /opt/claude-code/claude

FROM base AS runner
ARG SOURCE_COMMIT=""
ENV SOURCE_COMMIT=${SOURCE_COMMIT}
RUN apt-get update \
  && apt-get install -y --no-install-recommends git sqlite3 ca-certificates tzdata openssh-client \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/.output ./.output
COPY --from=builder /opt/claude-code /opt/claude-code
ENV NUXT_CLAUDE_CODE_PATH=/opt/claude-code/claude
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
# Its own unprivileged user for git in the GitHub evidence cache (server/utils/repos/git.ts), so
# demo build commands can read neither the read token in git's environment nor the cloned code.
RUN useradd --system --uid 10002 --user-group --create-home --shell /usr/sbin/nologin repos
# Its own unprivileged user for Claude Code on Devin's subscription (server/utils/agent-backend.ts),
# so neither demo build commands nor git can read the subscription token in its environment.
RUN useradd --system --uid 10003 --user-group --create-home --shell /usr/sbin/nologin claude

RUN mkdir -p /app/data /app/data/resumes

ENV NODE_ENV=production
ENV TZ=America/Chicago
ENV NUXT_DATABASE_PATH=/app/data/job-hunter.db
ENV HOST=0.0.0.0
ENV PORT=3000

EXPOSE 3000

CMD ["node", ".output/server/index.mjs"]
