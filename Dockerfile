FROM node:20-alpine

WORKDIR /app

# 先装依赖，充分利用镜像层缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js solver.js packing.js store.js ./
COPY public ./public

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data

# 数据目录（方案持久化，可挂载卷）
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3000

CMD ["node", "server.js"]
