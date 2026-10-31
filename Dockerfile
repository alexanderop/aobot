FROM node:26-slim
RUN npm install --global pnpm@11.28.10
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/domain/package.json packages/domain/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @aobot/web build

ENV PORT=3000 WEB_DIST_DIR=/app/apps/web/dist
EXPOSE 3000
CMD ["node", "apps/server/src/app/main.ts"]
