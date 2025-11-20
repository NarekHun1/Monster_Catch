# === ЭТАП 1: билд backend ===
FROM node:20-alpine AS builder
WORKDIR /app/backend

# 1. Ставим зависимости бекенда
COPY backend/package*.json ./
RUN npm ci

# 2. Копируем весь backend (код, prisma, src и т.д.)
COPY backend ./

# 3. Генерируем Prisma Client
RUN npx prisma generate

# 4. Собираем Nest
RUN npm run build

# === ЭТАП 2: рантайм ===
FROM node:20-alpine
WORKDIR /app/backend

ENV NODE_ENV=production

# 5. Копируем package.json, чтобы npm видел скрипты
COPY backend/package*.json ./

# 6. Копируем готовые зависимости, prisma и билд
COPY --from=builder /app/backend/node_modules ./node_modules
COPY --from=builder /app/backend/prisma ./prisma
COPY --from=builder /app/backend/dist ./dist

# 7. Запускаем тот же скрипт, что работает локально
CMD ["npm", "run", "start:prod"]
