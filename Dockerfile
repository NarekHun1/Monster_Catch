# ЭТАП 1: билд
FROM node:20-alpine AS builder
WORKDIR /app

# Ставим зависимости
COPY package*.json ./
RUN npm ci

# Копируем весь проект
COPY . .

# Собираем проект
RUN npm run build

# ЭТАП 2: рантайм
FROM node:20-alpine
WORKDIR /app

ENV NODE_ENV=production

# Берём готовые зависимости и билд из builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/dist ./dist

# Если у тебя входной файл другой — поправь здесь
CMD ["node", "dist/main.js"]
