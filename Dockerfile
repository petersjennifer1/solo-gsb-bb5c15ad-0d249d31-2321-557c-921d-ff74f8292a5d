FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# 先装依赖（利用镜像层缓存）；无 lock 文件时回退 npm install
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY server.js ./
COPY src ./src
COPY public ./public

EXPOSE 8080
CMD ["node", "server.js"]
