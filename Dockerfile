# The self-hosting entry point. No build stage: Node 26 runs the TypeScript sources as they are,
# so what runs in the container is the same text a reader opens in the repository.
FROM node:26-alpine

ENV NODE_ENV=production
WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN corepack pnpm@9.15.0 install --prod --frozen-lockfile

COPY src ./src

EXPOSE 4000
CMD ["node", "src/node.ts"]
