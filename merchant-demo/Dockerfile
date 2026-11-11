# nearpay-testbed merchant-demo image (lld/platform.md §1 `merchant-demo`, §3).
# Built by nearpay-deploy/scripts/up.sh with the context `nearpay-testbed/merchant-demo`:
#   docker build --network host --build-arg NP_REGISTRY_URL=http://127.0.0.1:4873 -t nearpay/merchant-demo:local .
# so @nearpay-money/* (spec, x402, agent-signer) install from the local registry (ADR-0001).

FROM node:22-bookworm-slim AS build
ARG NP_REGISTRY_URL=http://127.0.0.1:4873
ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --config.@nearpay-money:registry="${NP_REGISTRY_URL}/"
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

FROM node:22-bookworm-slim AS deps
ARG NP_REGISTRY_URL=http://127.0.0.1:4873
ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --config.@nearpay-money:registry="${NP_REGISTRY_URL}/"

FROM gcr.io/distroless/nodejs22-debian12:nonroot
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER 10001
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=12 CMD ["/nodejs/bin/node", "dist/main.js", "healthcheck"]
ENTRYPOINT ["/nodejs/bin/node"]
CMD ["dist/main.js"]
