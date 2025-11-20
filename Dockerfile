# === ЭТАП 1: билд ===
FROM node:20-alpine AS builder
WORKDIR /app

# 1. Ставим зависимости
COPY package*.json ./
RUN npm ci

# 2. Копируем весь проект (src, prisma и т.д.)
COPY . .

# 3. Генерируем Prisma Client
RUN npx prisma generate

# 4. Собираем Nest
RUN npm run build

# === ЭТАП 2: рантайм ===
FROM node:20-alpine
WORKDIR /app

ENV NODE_ENV=production

# 5. Копируем package.json, чтобы npm видел скрипты
COPY package*.json ./

# 6. Копируем зависимости, prisma и билд
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/dist ./dist

# 7. Стартуем прод как ты настроил
CMD ["npm", "run", "start:prod"]
