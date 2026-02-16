FROM node:20-slim

# 安装 FFmpeg, Python 和 yt-dlp
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    python3-venv \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 安装 yt-dlp（使用 pip）
RUN pip3 install --break-system-packages yt-dlp

# 验证安装
RUN ffmpeg -version && yt-dlp --version

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
