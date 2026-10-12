FROM node:20-bookworm-slim

# tzdata：让 TZ=Asia/Shanghai 生效，保证"今日用量"按本地日期统计
RUN apt-get update \
 && apt-get install -y --no-install-recommends tzdata ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 无第三方运行依赖，仅拷贝源码；config/ 运行时挂载，不打进镜像
COPY package.json ./
COPY server.js collector.js ./
COPY public ./public

ENV TZ=Asia/Shanghai

EXPOSE 8787
CMD ["node", "server.js"]
