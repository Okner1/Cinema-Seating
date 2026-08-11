FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
# schema.sql is read at runtime relative to the compiled migrate.js (dist/db/),
# but tsc only emits .ts files — copy it into dist explicitly.
RUN pnpm build && cp src/db/schema.sql dist/db/schema.sql

FROM node:24-slim
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist ./dist
CMD ["node", "dist/index.js"]
