# Node.js runs the TypeScript files as they are (type stripping); nothing is compiled.
FROM node:24.11-alpine3.22
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
    CMD wget -qO /dev/null http://127.0.0.1:8080/health || exit 1
USER node
ENTRYPOINT ["node", "src/main.ts"]
