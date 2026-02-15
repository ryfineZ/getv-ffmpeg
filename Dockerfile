FROM node:20-slim

# 安装 FFmpeg
RUN apt-get update && apt-get install -y \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# 创建应用目录
WORKDIR /app

# 复制 package.json
COPY package.json ./

# 安装依赖
RUN npm install --production

# 复制应用代码
COPY server.js ./

# 创建临时目录
RUN mkdir -p /tmp/getv-ffmpeg

# 暴露端口
EXPOSE 3000

# 环境变量
ENV PORT=3000
ENV TEMP_DIR=/tmp/getv-ffmpeg
ENV MAX_FILE_SIZE=524288000

# 启动服务
CMD ["node", "server.js"]
