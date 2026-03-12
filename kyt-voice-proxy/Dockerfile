FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --production=false

COPY . .

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

CMD ["npx", "tsx", "server.ts"]
