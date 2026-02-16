const express = require('express');
const cors = require('cors');
const ffmpeg = require('fluent-ffmpeg');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

// 临时文件目录
const TEMP_DIR = process.env.TEMP_DIR || '/tmp/getv-ffmpeg';
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE) || 500 * 1024 * 1024; // 500MB

// 确保临时目录存在
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// 中间件
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// 日志中间件
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

/**
 * 检测是否需要使用 yt-dlp 下载
 */
function needsYtdlp(url) {
  return url.includes('youtube.com') ||
         url.includes('youtu.be') ||
         url.includes('googlevideo.com') ||
         url.includes('.m3u8');
}

/**
 * 使用 yt-dlp 下载文件
 */
async function downloadWithYtdlp(url, outputPath) {
  return new Promise((resolve, reject) => {
    console.log(`[ytdlp] 下载: ${url.substring(0, 100)}...`);

    const ytdlp = spawn('yt-dlp', [
      '-f', 'best',
      '--no-warnings',
      '--no-playlist',
      '-o', outputPath,
      url
    ]);

    let stderr = '';

    ytdlp.stdout.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('[download]')) {
        console.log(`[ytdlp] ${msg.trim()}`);
      }
    });

    ytdlp.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ytdlp.on('error', (err) => {
      console.error('[ytdlp] 错误:', err.message);
      reject(new Error(`yt-dlp 启动失败: ${err.message}`));
    });

    ytdlp.on('close', (code) => {
      if (code === 0) {
        console.log(`[ytdlp] 下载完成: ${outputPath}`);
        resolve(outputPath);
      } else {
        reject(new Error(`yt-dlp 失败 (code ${code}): ${stderr}`));
      }
    });
  });
}

/**
 * 下载文件到临时目录
 * 自动检测 URL 类型，YouTube URL 使用 yt-dlp 下载
 */
async function downloadFile(url, filename) {
  const filePath = path.join(TEMP_DIR, filename);

  // 检测是否需要使用 yt-dlp
  if (needsYtdlp(url)) {
    return downloadWithYtdlp(url, filePath);
  }

  // 普通 URL 使用 http/https 下载
  const protocol = url.startsWith('https') ? https : http;

  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(filePath);
    let downloaded = 0;

    const request = protocol.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    }, (response) => {
      // 处理重定向
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        fs.unlinkSync(filePath);
        downloadFile(response.headers.location, filename).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(filePath);
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }

      response.pipe(file);

      response.on('data', (chunk) => {
        downloaded += chunk.length;
        if (downloaded > MAX_FILE_SIZE) {
          file.close();
          fs.unlinkSync(filePath);
          reject(new Error('文件大小超过限制'));
        }
      });

      file.on('finish', () => {
        file.close();
        resolve(filePath);
      });
    });

    request.on('error', (err) => {
      file.close();
      try { fs.unlinkSync(filePath); } catch {}
      reject(err);
    });

    // 设置超时
    request.setTimeout(30000, () => {
      request.destroy();
      reject(new Error('下载超时'));
    });
  });
}

/**
 * 清理临时文件
 */
function cleanupFiles(...files) {
  files.forEach(file => {
    try {
      if (file && fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    } catch (e) {
      console.error('清理文件失败:', e.message);
    }
  });
}

// ==================== API 端点 ====================

/**
 * 健康检查
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    ffmpeg: true,
    timestamp: new Date().toISOString()
  });
});

/**
 * 获取 FFmpeg 版本信息
 */
app.get('/info', (req, res) => {
  ffmpeg.ffprobe(null, (err, data) => {
    res.json({
      service: 'getv-ffmpeg',
      version: '1.0.0',
      ffmpegAvailable: true
    });
  });
});

/**
 * 合并音视频
 * POST /merge
 * Body: { videoUrl, audioUrl, outputFormat }
 */
app.post('/merge', async (req, res) => {
  const { videoUrl, audioUrl, outputFormat = 'mp4' } = req.body;

  if (!videoUrl || !audioUrl) {
    return res.status(400).json({ error: '缺少 videoUrl 或 audioUrl' });
  }

  const taskId = uuidv4();
  const videoFile = path.join(TEMP_DIR, `${taskId}_video`);
  const audioFile = path.join(TEMP_DIR, `${taskId}_audio`);
  const outputFile = path.join(TEMP_DIR, `${taskId}_output.${outputFormat}`);

  try {
    console.log(`[Merge] 开始下载文件, taskId: ${taskId}`);

    // 并行下载视频和音频
    await Promise.all([
      downloadFile(videoUrl, `${taskId}_video`),
      downloadFile(audioUrl, `${taskId}_audio`)
    ]);

    console.log(`[Merge] 文件下载完成，开始合并`);

    // 合并音视频
    await new Promise((resolve, reject) => {
      ffmpeg(videoFile)
        .input(audioFile)
        .outputOptions([
          '-c:v copy',           // 视频直接复制
          '-c:a aac',            // 音频转 AAC
          '-map 0:v:0',          // 使用第一个输入的视频
          '-map 1:a:0',          // 使用第二个输入的音频
          '-shortest'            // 以最短的流为准
        ])
        .output(outputFile)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    console.log(`[Merge] 合并完成，返回文件`);

    // 返回文件
    res.download(outputFile, `merged.${outputFormat}`, (err) => {
      cleanupFiles(videoFile, audioFile, outputFile);
      if (err) console.error('发送文件失败:', err);
    });

  } catch (error) {
    console.error('[Merge] 错误:', error);
    cleanupFiles(videoFile, audioFile, outputFile);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 视频剪辑
 * POST /trim
 * Body: { videoUrl, startTime, endTime, outputFormat }
 */
app.post('/trim', async (req, res) => {
  const { videoUrl, startTime, endTime, outputFormat = 'mp4' } = req.body;

  if (!videoUrl) {
    return res.status(400).json({ error: '缺少 videoUrl' });
  }

  if (startTime === undefined || endTime === undefined) {
    return res.status(400).json({ error: '缺少 startTime 或 endTime' });
  }

  const taskId = uuidv4();
  const inputFile = path.join(TEMP_DIR, `${taskId}_input`);
  const outputFile = path.join(TEMP_DIR, `${taskId}_output.${outputFormat}`);

  try {
    console.log(`[Trim] 开始下载文件, taskId: ${taskId}`);

    await downloadFile(videoUrl, `${taskId}_input`);

    console.log(`[Trim] 下载完成，开始剪辑 ${startTime} - ${endTime}`);

    await new Promise((resolve, reject) => {
      ffmpeg(inputFile)
        .setStartTime(startTime)
        .setDuration(endTime - startTime)
        .outputOptions([
          '-c copy',             // 直接复制，不重新编码
          '-avoid_negative_ts', 'make_zero'
        ])
        .output(outputFile)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    console.log(`[Trim] 剪辑完成，返回文件`);

    res.download(outputFile, `trimmed.${outputFormat}`, (err) => {
      cleanupFiles(inputFile, outputFile);
      if (err) console.error('发送文件失败:', err);
    });

  } catch (error) {
    console.error('[Trim] 错误:', error);
    cleanupFiles(inputFile, outputFile);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 格式转换
 * POST /convert
 * Body: { videoUrl, outputFormat, quality }
 */
app.post('/convert', async (req, res) => {
  const { videoUrl, outputFormat = 'mp4', quality = 'high' } = req.body;

  if (!videoUrl) {
    return res.status(400).json({ error: '缺少 videoUrl' });
  }

  const taskId = uuidv4();
  const inputFile = path.join(TEMP_DIR, `${taskId}_input`);
  const outputFile = path.join(TEMP_DIR, `${taskId}_output.${outputFormat}`);

  // 质量参数
  const qualitySettings = {
    high: { crf: 18, preset: 'slow' },
    medium: { crf: 23, preset: 'medium' },
    low: { crf: 28, preset: 'fast' }
  };
  const settings = qualitySettings[quality] || qualitySettings.medium;

  try {
    console.log(`[Convert] 开始下载文件, taskId: ${taskId}`);

    await downloadFile(videoUrl, `${taskId}_input`);

    console.log(`[Convert] 下载完成，开始转换`);

    let command = ffmpeg(inputFile);

    // 根据输出格式设置参数
    if (outputFormat === 'mp4') {
      command = command
        .outputOptions([
          '-c:v libx264',
          `-crf ${settings.crf}`,
          `-preset ${settings.preset}`,
          '-c:a aac',
          '-b:a 192k'
        ]);
    } else if (outputFormat === 'webm') {
      command = command
        .outputOptions([
          '-c:v libvpx-vp9',
          `-crf ${settings.crf}`,
          '-b:v 0',
          '-c:a libopus',
          '-b:a 128k'
        ]);
    } else if (outputFormat === 'mp3') {
      command = command
        .noVideo()
        .outputOptions([
          '-c:a libmp3lame',
          '-b:a 320k'
        ]);
    } else if (outputFormat === 'm4a') {
      command = command
        .noVideo()
        .outputOptions([
          '-c:a aac',
          '-b:a 256k'
        ]);
    }

    await new Promise((resolve, reject) => {
      command
        .output(outputFile)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    console.log(`[Convert] 转换完成，返回文件`);

    res.download(outputFile, `converted.${outputFormat}`, (err) => {
      cleanupFiles(inputFile, outputFile);
      if (err) console.error('发送文件失败:', err);
    });

  } catch (error) {
    console.error('[Convert] 错误:', error);
    cleanupFiles(inputFile, outputFile);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 提取音频
 * POST /extract-audio
 * Body: { videoUrl, format, bitrate }
 */
app.post('/extract-audio', async (req, res) => {
  const { videoUrl, format = 'mp3', bitrate = '320' } = req.body;

  if (!videoUrl) {
    return res.status(400).json({ error: '缺少 videoUrl' });
  }

  const taskId = uuidv4();
  const inputFile = path.join(TEMP_DIR, `${taskId}_input`);
  const outputFile = path.join(TEMP_DIR, `${taskId}_output.${format}`);

  try {
    console.log(`[ExtractAudio] 开始下载文件, taskId: ${taskId}`);

    await downloadFile(videoUrl, `${taskId}_input`);

    console.log(`[ExtractAudio] 下载完成，开始提取音频`);

    let command = ffmpeg(inputFile).noVideo();

    if (format === 'mp3') {
      command = command.outputOptions([
        '-c:a libmp3lame',
        `-b:a ${bitrate}k`
      ]);
    } else if (format === 'm4a' || format === 'aac') {
      command = command.outputOptions([
        '-c:a aac',
        `-b:a ${bitrate}k`
      ]);
    } else if (format === 'wav') {
      command = command.outputOptions([
        '-c:a pcm_s16le'
      ]);
    }

    await new Promise((resolve, reject) => {
      command
        .output(outputFile)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    console.log(`[ExtractAudio] 提取完成，返回文件`);

    res.download(outputFile, `audio.${format}`, (err) => {
      cleanupFiles(inputFile, outputFile);
      if (err) console.error('发送文件失败:', err);
    });

  } catch (error) {
    console.error('[ExtractAudio] 错误:', error);
    cleanupFiles(inputFile, outputFile);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取视频信息
 * POST /probe
 * Body: { videoUrl }
 */
app.post('/probe', async (req, res) => {
  const { videoUrl } = req.body;

  if (!videoUrl) {
    return res.status(400).json({ error: '缺少 videoUrl' });
  }

  const taskId = uuidv4();
  const inputFile = path.join(TEMP_DIR, `${taskId}_input`);

  try {
    await downloadFile(videoUrl, `${taskId}_input`);

    const info = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(inputFile, (err, data) => {
        if (err) reject(err);
        else resolve(data);
      });
    });

    cleanupFiles(inputFile);

    res.json({
      success: true,
      data: {
        duration: info.format.duration,
        size: info.format.size,
        format: info.format.format_name,
        streams: info.streams.map(s => ({
          type: s.codec_type,
          codec: s.codec_name,
          width: s.width,
          height: s.height,
          bitrate: s.bit_rate,
          fps: s.r_frame_rate
        }))
      }
    });

  } catch (error) {
    cleanupFiles(inputFile);
    res.status(500).json({ error: error.message });
  }
});

// 定时清理过期临时文件（每小时）
setInterval(() => {
  const files = fs.readdirSync(TEMP_DIR);
  const now = Date.now();
  const maxAge = 2 * 60 * 60 * 1000; // 2小时

  files.forEach(file => {
    const filePath = path.join(TEMP_DIR, file);
    const stat = fs.statSync(filePath);
    if (now - stat.mtimeMs > maxAge) {
      fs.unlinkSync(filePath);
      console.log(`[Cleanup] 删除过期文件: ${file}`);
    }
  });
}, 60 * 60 * 1000);

// 启动服务器
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 FFmpeg API 服务已启动`);
  console.log(`   端口: ${PORT}`);
  console.log(`   临时目录: ${TEMP_DIR}`);
  console.log(`   最大文件: ${MAX_FILE_SIZE / 1024 / 1024}MB`);
});

module.exports = app;
