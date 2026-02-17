# GetV FFmpeg API

视频处理 API 服务，支持音视频合并、视频剪辑、格式转换等功能。

## API 端点

### 健康检查
```
GET /health
```

### 合并音视频
```
POST /merge
Content-Type: application/json

{
  "videoUrl": "https://example.com/video.mp4",
  "audioUrl": "https://example.com/audio.m4a",
  "outputFormat": "mp4"
}
```

### 视频剪辑
```
POST /trim
Content-Type: application/json

{
  "videoUrl": "https://example.com/video.mp4",
  "startTime": 10,      // 秒
  "endTime": 60,        // 秒
  "outputFormat": "mp4"
}
```

### 格式转换
```
POST /convert
Content-Type: application/json

{
  "videoUrl": "https://example.com/video.webm",
  "outputFormat": "mp4",  // mp4, webm, mp3, m4a
  "quality": "high"       // high, medium, low
}
```

### 提取音频
```
POST /extract-audio
Content-Type: application/json

{
  "videoUrl": "https://example.com/video.mp4",
  "format": "mp3",        // mp3, m4a, aac, wav
  "bitrate": 320
}
```

### 获取视频信息
```
POST /probe
Content-Type: application/json

{
  "videoUrl": "https://example.com/video.mp4"
}
```

## Coolify 部署

1. 在 Coolify 中创建新资源
2. 选择 "Git Repository"
3. 导入此仓库
4. Coolify 会自动检测 Dockerfile 并构建
5. 配置域名（如 `ffmpeg.getv.top`）
6. 启用 HTTPS

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| PORT | 3000 | 服务端口 |
| TEMP_DIR | /tmp/getv-ffmpeg | 临时文件目录 |
| MAX_FILE_SIZE | 524288000 | 最大文件大小 (500MB) |

## 本地开发

```bash
# 安装依赖
npm install

# 启动服务
npm start
```

## 技术栈

- Node.js 20
- Express
- FFmpeg
- fluent-ffmpeg

