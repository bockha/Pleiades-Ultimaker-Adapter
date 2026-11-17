# Node.js runs the TypeScript files as they are (type stripping); nothing is compiled.
# The dependencies are installed in a build stage; the final image carries neither npm nor yarn,
# which the adapter does not need at run time, and takes the current Alpine package fixes.
FROM node:24.11-alpine3.22 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:24.11-alpine3.22
RUN apk upgrade --no-cache && \
    rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
    CMD wget -qO /dev/null http://127.0.0.1:8080/health || exit 1
USER node
ENTRYPOINT ["node", "src/main.ts"]
