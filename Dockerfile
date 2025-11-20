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

COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production

CMD ["node", "dist/main.js"]
