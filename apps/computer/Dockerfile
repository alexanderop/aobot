# The Bot's computer: Node, Playwright, a headed Chromium on Xvfb and bash in /workspace, run as the image's
# non-root `pwuser`.
# Built from the repository root, because it imports packages/domain:
#   docker build -f apps/computer/Dockerfile -t aobot-computer:dev .
#
# The Playwright base image and the `playwright` dependency in apps/computer/package.json are the same
# exact version, so the browsers in the image are the ones the library drives. Bump both or neither.
FROM node:26-slim AS node

FROM node AS install
RUN npm install --global pnpm@11.28.10
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/computer/package.json apps/computer/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/domain/package.json packages/domain/
RUN pnpm install --frozen-lockfile --prod --filter "@aobot/computer..."
COPY packages/domain/src packages/domain/src
COPY apps/computer/src apps/computer/src

FROM mcr.microsoft.com/playwright:v1.64.1-noble
# Node 26 runs the TypeScript sources as they are, as the server image does.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
# tini as PID 1 reaps the processes Chromium leaves behind, which node would not.
RUN apt-get update \
  && apt-get install -y --no-install-recommends xvfb tini \
  && rm -rf /var/lib/apt/lists/*
RUN mkdir /workspace && chown pwuser:pwuser /workspace
WORKDIR /app
COPY --from=install /app /app

USER pwuser
ENV HOME=/home/pwuser PORT=4100
EXPOSE 4100
HEALTHCHECK --interval=2s --timeout=3s --start-period=5s --retries=30 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4100/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/computer/src/app/main.ts"]
