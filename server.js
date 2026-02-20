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
async function downloadFile(url, filename, headers = {}) {
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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ...headers,
      }
    }, (response) => {
      // 处理重定向
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        fs.unlinkSync(filePath);
        downloadFile(response.headers.location, filename, headers).then(resolve).catch(reject);
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
      try { fs.unlinkSync(filePath); } catch { }
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
    ytdlp: true,
    timestamp: new Date().toISOString()
  });
});

/**
 * 解析视频信息
 * POST /parse
 * Body: { url }
 * 使用 yt-dlp ��取视频元数据和下载链接
 */
app.post('/parse', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ success: false, error: '缺少 url' });
  }

  console.log(`[Parse] 解析: ${url.substring(0, 100)}...`);

  try {
    // 使用 yt-dlp 获取视频信息（JSON 格式）
    const info = await new Promise((resolve, reject) => {
      const ytdlp = spawn('yt-dlp', [
        '--no-warnings',
        '--no-playlist',
        '--dump-json',
        '-f', 'bestvideo+bestaudio/best',
        url
      ]);

      let stdout = '';
      let stderr = '';

      ytdlp.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      ytdlp.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      ytdlp.on('error', (err) => {
        reject(new Error(`yt-dlp 启动失败: ${err.message}`));
      });

      ytdlp.on('close', (code) => {
        if (code === 0) {
          try {
            resolve(JSON.parse(stdout));
          } catch (e) {
            reject(new Error('解析 JSON 失败'));
          }
        } else {
          reject(new Error(`yt-dlp 失败: ${stderr}`));
        }
      });
    });

    // 构建格式列表
    const formats = [];

    // 添加渐进式格式（视频+音频）
    if (info.formats) {
      // 合并格式（有视频有音频）
      const mergedFormats = info.formats.filter(f =>
        f.vcodec !== 'none' && f.acodec !== 'none' && f.url
      );

      // 仅视频格式
      const videoOnlyFormats = info.formats.filter(f =>
        f.vcodec !== 'none' && (f.acodec === 'none' || !f.acodec) && f.url
      );

      // 仅音频格式
      const audioOnlyFormats = info.formats.filter(f =>
        (f.vcodec === 'none' || !f.vcodec) && f.acodec !== 'none' && f.url
      );

      // 处理合并格式
      for (const f of mergedFormats) {
        const quality = f.format_note || f.height ? `${f.height}p` : 'default';
        formats.push({
          id: f.format_id || `merged-${f.height}`,
          quality,
          format: f.ext || 'mp4',
          size: f.filesize || f.filesize_approx,
          sizeText: f.filesize ? formatBytes(f.filesize) : (f.filesize_approx ? formatBytes(f.filesize_approx) : undefined),
          url: f.url,
          hasVideo: true,
          hasAudio: true,
          bitrate: f.tbr,
        });
      }

      // 处理仅视频格式
      for (const f of videoOnlyFormats) {
        const quality = f.format_note || f.height ? `${f.height}p` : 'default';
        formats.push({
          id: f.format_id || `video-${f.height}`,
          quality,
          format: f.ext || 'mp4',
          size: f.filesize || f.filesize_approx,
          sizeText: f.filesize ? formatBytes(f.filesize) : (f.filesize_approx ? formatBytes(f.filesize_approx) : undefined),
          url: f.url,
          hasVideo: true,
          hasAudio: false,
          bitrate: f.tbr,
          codec: f.vcodec,
          fps: f.fps,
        });
      }

      // 处理仅音频格式（取最高音质）
      const bestAudio = audioOnlyFormats.sort((a, b) => (b.tbr || 0) - (a.tbr || 0))[0];
      if (bestAudio) {
        formats.push({
          id: bestAudio.format_id || 'audio-best',
          quality: `音频 (${Math.round((bestAudio.tbr || 0) / 1000)}kbps)`,
          format: bestAudio.ext || 'm4a',
          size: bestAudio.filesize || bestAudio.filesize_approx,
          sizeText: bestAudio.filesize ? formatBytes(bestAudio.filesize) : undefined,
          url: bestAudio.url,
          hasVideo: false,
          hasAudio: true,
          bitrate: bestAudio.tbr,
        });
      }
    }

    // 按画质排序
    formats.sort((a, b) => {
      const qualityOrder = ['2160p', '1440p', '1080p', '720p', '480p', '360p', '240p', '144p'];
      const aIndex = qualityOrder.indexOf(a.quality);
      const bIndex = qualityOrder.indexOf(b.quality);
      return aIndex - bIndex;
    });

    console.log(`[Parse] 成功, 标题: ${info.title}, 格式数: ${formats.length}`);

    res.json({
      success: true,
      data: {
        id: info.id,
        platform: 'youtube',
        title: info.title || '未知标题',
        description: info.description,
        thumbnail: info.thumbnail,
        duration: info.duration,
        durationText: formatDuration(info.duration),
        author: info.uploader || info.channel,
        formats,
        originalUrl: url,
        parsedAt: Date.now(),
      }
    });

  } catch (error) {
    console.error('[Parse] 错误:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 格式化字节
 */
function formatBytes(bytes) {
  if (!bytes) return undefined;
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

/**
 * 格式化时长
 */
function formatDuration(seconds) {
  if (!seconds) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

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

// ==================== 异步任务管理 ====================

/**
 * 任务状态存储（内存，重启后清空）
 * { taskId: { status: 'pending'|'processing'|'done'|'error', outputFile, filename, error, createdAt } }
 */
const tasks = new Map();

/**
 * 后台执行下载任务
 */
async function runDownloadTask(taskId, { videoUrl, formatId, audioUrl, action, trim, audioFormat, audioBitrate, referer }) {
  const task = tasks.get(taskId);
  if (!task) return;

  task.status = 'processing';
  const dlHeaders = referer ? { 'Referer': referer } : {};

  try {
    // ---- action: download ----
    if (action === 'download') {
      if (needsYtdlp(videoUrl)) {
        const outputFile = path.join(TEMP_DIR, `${taskId}_output.mp4`);

        let formatArg;
        if (formatId) {
          const hasAudioFormats = ['18', '22', '36', '17', '5', '6'];
          formatArg = hasAudioFormats.includes(formatId) ? formatId : `${formatId}+bestaudio/best`;
        } else {
          formatArg = 'bestvideo+bestaudio/best';
        }

        console.log(`[Task:${taskId}] yt-dlp format: ${formatArg}`);

        await new Promise((resolve, reject) => {
          const ytdlp = spawn('yt-dlp', [
            '-f', formatArg,
            '--no-warnings',
            '--no-playlist',
            '--merge-output-format', 'mp4',
            '-o', outputFile,
            videoUrl
          ]);
          let stderr = '';
          ytdlp.stdout.on('data', d => { if (d.toString().includes('[download]')) console.log(`[Task:${taskId}] ${d.toString().trim()}`); });
          ytdlp.stderr.on('data', d => { stderr += d.toString(); });
          ytdlp.on('error', err => reject(new Error(`yt-dlp 启动失败: ${err.message}`)));
          ytdlp.on('close', code => code === 0 ? resolve() : reject(new Error(`yt-dlp 失败 (code ${code}): ${stderr}`)));
        });

        task.outputFile = outputFile;
        task.filename = 'video.mp4';
      } else {
        const inputFile = path.join(TEMP_DIR, `${taskId}_input`);
        await downloadFile(videoUrl, `${taskId}_input`, dlHeaders);
        task.outputFile = inputFile;
        task.filename = 'video.mp4';
      }
    }

    // ---- action: merge ----
    else if (action === 'merge' && audioUrl) {
      const videoFile = path.join(TEMP_DIR, `${taskId}_video`);
      const audioFile = path.join(TEMP_DIR, `${taskId}_audio`);
      const outputFile = path.join(TEMP_DIR, `${taskId}_output.mp4`);

      await Promise.all([
        downloadFile(videoUrl, `${taskId}_video`, dlHeaders),
        downloadFile(audioUrl, `${taskId}_audio`, dlHeaders)
      ]);

      await new Promise((resolve, reject) => {
        ffmpeg(videoFile)
          .input(audioFile)
          .outputOptions(['-c:v copy', '-c:a aac', '-map 0:v:0', '-map 1:a:0', '-shortest'])
          .output(outputFile)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });

      // 清理中间文件
      cleanupFiles(videoFile, audioFile);
      task.outputFile = outputFile;
      task.filename = 'video.mp4';
    }

    // ---- action: trim ----
    else if (action === 'trim' && trim) {
      const inputFile = path.join(TEMP_DIR, `${taskId}_input`);
      const outputFile = path.join(TEMP_DIR, `${taskId}_output.mp4`);

      await downloadFile(videoUrl, `${taskId}_input`, dlHeaders);

      await new Promise((resolve, reject) => {
        ffmpeg(inputFile)
          .setStartTime(trim.start)
          .setDuration(trim.end - trim.start)
          .outputOptions(['-c copy', '-avoid_negative_ts make_zero'])
          .output(outputFile)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });

      cleanupFiles(inputFile);
      task.outputFile = outputFile;
      task.filename = 'video.mp4';
    }

    // ---- action: extract-audio ----
    else if (action === 'extract-audio') {
      const fmt = audioFormat || 'mp3';
      const inputFile = path.join(TEMP_DIR, `${taskId}_input`);
      const outputFile = path.join(TEMP_DIR, `${taskId}_output.${fmt}`);

      await downloadFile(videoUrl, `${taskId}_input`, dlHeaders);

      let command = ffmpeg(inputFile).noVideo();
      if (fmt === 'mp3') {
        command = command.outputOptions(['-c:a libmp3lame', `-b:a ${audioBitrate || 320}k`]);
      } else if (fmt === 'm4a' || fmt === 'aac') {
        command = command.outputOptions(['-c:a aac', `-b:a ${audioBitrate || 320}k`]);
      } else if (fmt === 'wav') {
        command = command.outputOptions(['-c:a pcm_s16le']);
      }

      await new Promise((resolve, reject) => {
        command.output(outputFile).on('end', resolve).on('error', reject).run();
      });

      cleanupFiles(inputFile);
      task.outputFile = outputFile;
      task.filename = `audio.${fmt}`;
    }

    else {
      throw new Error('不支持的操作');
    }

    task.status = 'done';
    console.log(`[Task:${taskId}] 完成: ${task.outputFile}`);

  } catch (error) {
    console.error(`[Task:${taskId}] 失败:`, error.message);
    task.status = 'error';
    task.error = error.message;
  }
}

/**
 * 下载视频（异步任务模式）
 * POST /download
 * Body: { videoUrl, formatId, audioUrl, action, trim, audioFormat, audioBitrate, referer }
 * 立即返回 taskId，客户端轮询 GET /task/:taskId
 */
app.post('/download', (req, res) => {
  const { videoUrl, action = 'download', audioUrl } = req.body;

  if (!videoUrl) {
    return res.status(400).json({ error: '缺少 videoUrl' });
  }

  // 提前校验 merge 必须有 audioUrl
  if (action === 'merge' && !audioUrl) {
    return res.status(400).json({ error: '不支持的操作' });
  }

  const taskId = uuidv4();
  tasks.set(taskId, { status: 'pending', outputFile: null, filename: null, error: null, createdAt: Date.now() });

  // 异步执行，不等待
  runDownloadTask(taskId, req.body).catch(err => console.error(`[Task:${taskId}] 未捕获错误:`, err));

  res.json({ taskId });
});

/**
 * 查询任务状态
 * GET /task/:taskId
 */
app.get('/task/:taskId', (req, res) => {
  const task = tasks.get(req.params.taskId);
  if (!task) return res.status(404).json({ error: '任务不存在' });

  res.json({
    taskId: req.params.taskId,
    status: task.status,   // pending | processing | done | error
    error: task.error || undefined,
  });
});

/**
 * 下载任务结果文件
 * GET /task/:taskId/file
 */
app.get('/task/:taskId/file', (req, res) => {
  const task = tasks.get(req.params.taskId);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.status !== 'done') return res.status(400).json({ error: `任务状态: ${task.status}` });
  if (!task.outputFile || !fs.existsSync(task.outputFile)) return res.status(404).json({ error: '文件不存在' });

  res.download(task.outputFile, task.filename, (err) => {
    cleanupFiles(task.outputFile);
    tasks.delete(req.params.taskId);
    if (err) console.error('发送文件失败:', err);
  });
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
  console.log(`FFmpeg API v1.1.0 started`);
  console.log(`   Port: ${PORT}`);
  console.log(`   Temp: ${TEMP_DIR}`);
  console.log(`   Max file: ${MAX_FILE_SIZE / 1024 / 1024}MB`);
});

module.exports = app;
