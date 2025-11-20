# ЭТАП 1: билд
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ЭТАП 2: рантайм
FROM node:20-alpine
WORKDIR /app

ENV NODE_ENV=production

# Берём готовые зависимости и билд из builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/dist ./dist

CMD ["node", "dist/main.js"]
