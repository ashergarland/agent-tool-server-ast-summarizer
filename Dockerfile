FROM node:22-alpine AS build
WORKDIR /build

COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build \
  && npm ci --omit=dev --ignore-scripts \
  && npm cache clean --force

FROM node:22-alpine AS runtime
ARG GIT_SHA=unknown
ARG SERVICE_VERSION=0.0.0-development
# No workspace is configured on purpose. Hosting is opt-in: until an operator mounts a read-only
# source volume and sets AST_WORKSPACE_ROOT, the server starts, stays live, and reports not ready.
# The application directory, dist, and node_modules are never a caller workspace.
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    GIT_SHA=${GIT_SHA} \
    SERVICE_VERSION=${SERVICE_VERSION}
WORKDIR /app

COPY --from=build --chown=root:root /build/node_modules ./node_modules
COPY --from=build --chown=root:root /build/dist ./dist
COPY --chown=root:root package.json ./

# Create the conventional read-only mount point so a volume can be attached without a writable layer.
RUN mkdir -p /workspace && chown root:root /workspace

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/index.js"]
