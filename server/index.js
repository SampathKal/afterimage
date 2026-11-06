require("dotenv").config({
  path: require("path").resolve(__dirname, "../.env")
});

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const dns = require("dns").promises;
const net = require("net");
const { spawn } = require("child_process");
const { v4: uuidv4 } = require("uuid");
const OpenAI = require("openai");

const app = express();
const cors = require("cors");
app.use(cors({
  origin: [
    "http://localhost:5173",
    "https://afterimage-dun.vercel.app",
    "https://afterimage-h371ji0ib-kalagarlasampath-5113s-projects.vercel.app",
    "https://afterimage-ohhzko5fv-kalagarlasampath-5113s-projects.vercel.app",
    "https://afterimage-2p1geel1m-kalagarlasampath-5113s-projects.vercel.app",
    "https://afterimage.vercel.app"
  ]
}));
const PORT = process.env.PORT || 8787;

const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, "uploads");
const OUTPUT_DIR = path.join(ROOT, "output");
const TEMP_DIR = path.join(ROOT, "temp");

for (const dir of [UPLOAD_DIR, OUTPUT_DIR, TEMP_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const ffmpeg = require("ffmpeg-static");
const ffprobe = require("ffprobe-static").path;

if (!ffmpeg || !ffprobe) {
  throw new Error("FFmpeg or FFprobe is unavailable.");
}

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const TRANSCRIPTION_MODEL = process.env.TRANSCRIPTION_MODEL || "whisper-1";

// Cost and processing safeguards.
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 500);
const MAX_DURATION = Number(process.env.MAX_VIDEO_DURATION_SECONDS || 7200);
const MAX_TRANSCRIPTION_MINUTES = Number(
  process.env.MAX_TRANSCRIPTION_MINUTES || 60
);
const AUDIO_CHUNK_SECONDS = 480;
const MAX_HIGHLIGHTS = 20;

app.use(express.json({ limit: "2mb" }));
app.use("/output", express.static(OUTPUT_DIR));

const jobs = new Map();

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    cb(null, `${uuidv4()}${path.extname(file.originalname).toLowerCase()}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_UPLOAD_MB * 1024 * 1024,
    files: 5
  },
  fileFilter: (req, file, cb) => {
    const allowed = [".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"];
    const ext = path.extname(file.originalname).toLowerCase();

    if (!allowed.includes(ext)) {
      return cb(new Error("Unsupported video format."));
    }

    cb(null, true);
  }
});

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      ...options
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", data => {
      stdout += data.toString();
    });

    child.stderr?.on("data", data => {
      stderr += data.toString();
    });

    child.on("error", reject);

    child.on("close", code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });
}

function safeTimestamp(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = String(Math.floor(total / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const secs = String(total % 60).padStart(2, "0");
  return `${hours}:${minutes}:${secs}`;
}

function parseTimestamp(value) {
  if (typeof value === "number") return value;

  const parts = String(value || "0").split(":").map(Number);

  if (parts.some(n => !Number.isFinite(n) || n < 0)) {
    throw new Error("Invalid timestamp.");
  }

  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }

  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];

  throw new Error("Use HH:MM:SS for timestamps.");
}

async function getVideoInfo(filePath) {
  const { stdout } = await runCommand(ffprobe, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "json",
    filePath
  ]);

  const data = JSON.parse(stdout);
  const duration = Number(data.format?.duration);

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Could not determine video duration.");
  }

  if (duration > MAX_DURATION) {
    throw new Error(`Video exceeds the ${MAX_DURATION}-second limit.`);
  }

  return duration;
}

function isPrivateAddress(address) {
  const family = net.isIP(address);

  if (family === 4) {
    const p = address.split(".").map(Number);
    return p[0] === 10 || p[0] === 127 || p[0] === 0 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168);
  }

  if (family === 6) {
    const a = address.toLowerCase();
    return a === "::1" || a.startsWith("fc") || a.startsWith("fd") ||
      a.startsWith("fe80:") || a.startsWith("::ffff:127.") ||
      a.startsWith("::ffff:10.") || a.startsWith("::ffff:192.168.");
  }

  return true;
}

function validateYouTubeUrl(rawUrl) {
  let parsed;

  try {
    parsed = new URL(String(rawUrl));
  } catch {
    throw new Error("Invalid YouTube URL.");
  }

  const host = parsed.hostname.toLowerCase();
  const allowed = ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"];

  if (!["https:", "http:"].includes(parsed.protocol) ||
      !allowed.includes(host) || parsed.username || parsed.password) {
    throw new Error("Please enter a valid YouTube video URL.");
  }

  let id = "";

  if (host === "youtu.be") {
    id = parsed.pathname.split("/").filter(Boolean)[0] || "";
  } else if (parsed.pathname === "/watch") {
    id = parsed.searchParams.get("v") || "";
  } else {
    const match = parsed.pathname.match(/^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]+)/);
    id = match ? match[1] : "";
  }

  if (!/^[A-Za-z0-9_-]{6,}$/.test(id)) {
    throw new Error("Enter a single YouTube video link.");
  }

  return `https://www.youtube.com/watch?v=${id}`;
}

async function downloadYouTubeVideo(url, destination) {
  const safeUrl = validateYouTubeUrl(url);
  const python = process.env.PYTHON_COMMAND || "py";
  const id = uuidv4();
  const template = path.join(TEMP_DIR, `${id}.%(ext)s`);
  let downloadedPath;

  const args = [
    "-m", "yt_dlp",
    "--no-playlist",
    "--no-progress",
    "--js-runtimes", "node",
    "--remote-components", "ejs:github",
    "--max-filesize", `${MAX_UPLOAD_MB}M`,
    "-f", "18/b[height<=720]/best[height<=720]/best",
    "-o", template,
    safeUrl
  ];

  try {
    await runCommand(python, args);

    const name = fs.readdirSync(TEMP_DIR).find(n =>
      n.startsWith(`${id}.`) && !n.endsWith(".part")
    );

    if (!name) throw new Error("yt-dlp did not create a video file.");

    downloadedPath = path.join(TEMP_DIR, name);

    const stats = fs.statSync(downloadedPath);
    if (!stats.isFile() || !stats.size) {
      throw new Error("The downloaded video file is empty.");
    }

    if (stats.size > MAX_UPLOAD_MB * 1024 * 1024) {
      throw new Error("The downloaded video exceeds the upload size limit.");
    }

    await runCommand(ffmpeg, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-i", downloadedPath,
      "-t", String(MAX_DURATION),
      "-c:v", "libx264", "-preset", "ultrafast",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-movflags", "+faststart",
      destination
    ]);

    return destination;
  } catch (error) {
    try {
      if (fs.existsSync(destination)) fs.unlinkSync(destination);
    } catch {}

    throw new Error(`YouTube download failed: ${error.message}`);
  } finally {
    try {
      for (const name of fs.readdirSync(TEMP_DIR)) {
        if (name.startsWith(`${id}.`)) {
          fs.unlinkSync(path.join(TEMP_DIR, name));
        }
      }
    } catch {}
  }
}

async function downloadVideo(url, destination) {
  let parsed;

  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Please provide a valid direct video URL.");
  }

  if (!["http:", "https:"].includes(parsed.protocol) ||
      parsed.username || parsed.password) {
    throw new Error("Only public HTTP and HTTPS video URLs are supported.");
  }

  const addresses = await dns.lookup(parsed.hostname, { all: true });

  if (!addresses.length || addresses.some(a => isPrivateAddress(a.address))) {
    throw new Error("This video URL cannot be accessed for safety reasons.");
  }

  const response = await fetch(parsed.toString(), {
    redirect: "error",
    signal: AbortSignal.timeout(60000)
  });

  if (!response.ok) throw new Error(`Video download failed: HTTP ${response.status}`);

  const type = response.headers.get("content-type") || "";
  if (!type.startsWith("video/") && !/application\/octet-stream/i.test(type)) {
    throw new Error("The URL must point directly to a video file.");
  }

  const maxBytes = MAX_UPLOAD_MB * 1024 * 1024;
  const file = fs.createWriteStream(destination);
  let received = 0;

  try {
    for await (const chunk of response.body) {
      received += chunk.length;
      if (received > maxBytes) throw new Error("Video exceeds the upload size limit.");

      if (!file.write(chunk)) {
        await new Promise((resolve, reject) => {
          file.once("drain", resolve);
          file.once("error", reject);
        });
      }
    }

    await new Promise((resolve, reject) => {
      file.end();
      file.once("finish", resolve);
      file.once("error", reject);
    });
  } catch (error) {
    file.destroy();
    try {
      if (fs.existsSync(destination)) fs.unlinkSync(destination);
    } catch {}
    throw error;
  }

  return destination;
}

// Extract audio in small MP3 chunks so long videos do not exceed
// the transcription upload limit.
async function extractAudioChunks(videoPath, duration, directory) {
  fs.mkdirSync(directory, { recursive: true });

  const chunks = [];
  const count = Math.ceil(duration / AUDIO_CHUNK_SECONDS);

  for (let i = 0; i < count; i++) {
    const start = i * AUDIO_CHUNK_SECONDS;
    const length = Math.min(AUDIO_CHUNK_SECONDS, duration - start);
    const output = path.join(directory, `audio-${i}.mp3`);

    await runCommand(ffmpeg, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-ss", String(start),
      "-i", videoPath,
      "-t", String(length),
      "-vn",
      "-ac", "1",
      "-ar", "16000",
      "-b:a", "48k",
      output
    ]);

    chunks.push({ path: output, start, end: start + length });
  }

  return chunks;
}

async function transcribeVideo(videoPath, duration, job) {
  if (!openai) {
    throw new Error("Add OPENAI_API_KEY to your .env file to use transcription.");
  }

  const minutes = duration / 60;

  if (minutes > MAX_TRANSCRIPTION_MINUTES) {
    throw new Error(
      `This video is ${Math.ceil(minutes)} minutes long. ` +
      `The current transcription limit is ${MAX_TRANSCRIPTION_MINUTES} minutes.`
    );
  }

  const directory = path.join(TEMP_DIR, job.id, "audio");
  const chunks = await extractAudioChunks(videoPath, duration, directory);
  const transcript = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    job.stage = `Transcribing audio (${i + 1}/${chunks.length})`;
    job.progress = 10 + Math.round((i / chunks.length) * 25);

    const result = await openai.audio.transcriptions.create({
      file: fs.createReadStream(chunk.path),
      model: TRANSCRIPTION_MODEL,
      response_format: "verbose_json",
      timestamp_granularities: ["segment"]
    });

    for (const segment of result.segments || []) {
      const text = String(segment.text || "").trim();
      if (!text) continue;

      transcript.push({
        start: chunk.start + Number(segment.start || 0),
        end: chunk.start + Number(segment.end || 0),
        text
      });
    }
  }

  return transcript.sort((a, b) => a.start - b.start);
}

function transcriptToText(segments) {
  return segments.map(s =>
    `[${safeTimestamp(s.start)} - ${safeTimestamp(s.end)}] ${s.text}`
  ).join("\n");
}

function extractJson(text) {
  const match = String(text || "").match(/\{[\s\S]*\}/);
  if (!match) throw new Error("The AI returned an unreadable response.");
  return JSON.parse(match[0]);
}

// Analyze manageable transcript sections separately.
// Each result is mapped back to the original video timeline.
async function findHighlights(transcript, question, job) {
  if (!transcript.length) return [];

  const groups = [];
  let current = [];
  let groupStart = transcript[0].start;

  for (const segment of transcript) {
    if (segment.start - groupStart > 240 && current.length) {
      groups.push(current);
      current = [];
      groupStart = segment.start;
    }
    current.push(segment);
  }

  if (current.length) groups.push(current);

  const candidates = [];

  for (let i = 0; i < groups.length; i++) {
    job.stage = `Finding meaningful moments (${i + 1}/${groups.length})`;
    job.progress = 38 + Math.round((i / groups.length) * 42);

    const group = groups[i];
    const text = transcriptToText(group);

    const response = await openai.responses.create({
      model: MODEL,
      input: [{
        role: "user",
        content: [{
          type: "input_text",
          text: `
You are the highlight editor for Afterimage.

Analyze this transcript from a longer video and find moments that could work
as independent short-form video clips.

User's requested focus:
${question || "Find the most interesting, useful, entertaining, or memorable moments."}

TRANSCRIPT:
${text}

Look for moments such as:
- A complete and interesting story
- A surprising or memorable statement
- A useful explanation or insight
- A strong question followed by a meaningful answer
- A funny or engaging exchange
- A compelling opinion or realization
- A clear demonstration or teaching moment

Do not select ordinary filler, greetings, repeated information, or incomplete sentences.
Do not invent dialogue or claim something happened if the transcript does not support it.
Each candidate should make sense without requiring the entire original video.
Avoid selecting multiple overlapping moments about the same point.

Return JSON only:
{
  "highlights": [
    {
      "start": 120.0,
      "end": 165.0,
      "title": "Short descriptive title",
      "description": "What happens in this moment",
      "hook": "Why someone might keep watching",
      "reason": "Why this is worth clipping",
      "importanceScore": 85,
      "confidence": 0.9
    }
  ]
}

Use timestamps from the transcript.
The start and end must be within this transcript section.
Aim for clips between 15 and 90 seconds when the content allows.
Do not force a moment into that duration if doing so would cut off its meaning.
Return no more than 5 highlights from this section.
importanceScore must be 0-100. confidence must be 0-1.
`
        }]
      }]
    });

    const parsed = extractJson(response.output_text);
    const min = group[0].start;
    const max = group[group.length - 1].end;

    for (const item of parsed.highlights || []) {
      const start = Math.max(min, Number(item.start));
      const end = Math.min(max, Number(item.end));

      if (!Number.isFinite(start) || !Number.isFinite(end) ||
          end <= start || end - start < 8) continue;

      candidates.push({
        timestamp: start,
        start,
        end,
        time: safeTimestamp(start),
        endTime: safeTimestamp(end),
        title: String(item.title || "Highlight"),
        description: String(item.description || ""),
        hook: String(item.hook || ""),
        reason: String(item.reason || ""),
        importanceScore: Math.max(0, Math.min(100, Number(item.importanceScore) || 0)),
        confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0)),
        mode: "transcript-ai"
      });
    }
  }

  // Remove near-duplicate overlapping candidates.
  candidates.sort((a, b) => b.importanceScore - a.importanceScore);

  const selected = [];

  for (const candidate of candidates) {
    const overlaps = selected.some(existing =>
      Math.max(candidate.start, existing.start) <
      Math.min(candidate.end, existing.end) * 0.85
    );

    if (!overlaps) selected.push(candidate);
    if (selected.length >= MAX_HIGHLIGHTS) break;
  }

  return selected.sort((a, b) => a.start - b.start);
}


// Extract frames from a video for visual analysis.
async function extractVideoFrames(videoPath, start, end, job, videoIndex) {
  const duration = end - start;

  // Limit the number of frames to control processing time and API cost.
  const maxFrames = 120;
  const interval = Math.max(3, Math.ceil(duration / maxFrames));

  const directory = path.join(
    TEMP_DIR,
    job.id,
    `video-${videoIndex}-frames`
  );

  fs.mkdirSync(directory, { recursive: true });

  job.stage = "Extracting video frames";
  job.progress = 15;

  await runCommand(ffmpeg, [
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    "-ss", String(start),
    "-i", videoPath,
    "-t", String(duration),
    "-vf", `fps=1/${interval},scale=640:-2`,
    "-q:v", "5",
    path.join(directory, "frame-%04d.jpg")
  ]);

  const files = fs.readdirSync(directory)
    .filter(name => name.endsWith(".jpg"))
    .sort();

  return files.map((name, index) => ({
    path: path.join(directory, name),
    timestamp: Math.min(end, start + index * interval),
    time: safeTimestamp(Math.min(end, start + index * interval))
  }));
}

// Ask the vision model to identify events visible in a batch of frames.
async function analyzeVisualFrames(frames, question, rangeStart, rangeEnd, job) {
  if (!frames.length) return [];

  const batchSize = 10;
  const candidates = [];

  for (let i = 0; i < frames.length; i += batchSize) {
    const batch = frames.slice(i, i + batchSize);

    job.stage = `Visually analyzing frames (${Math.min(i + batch.length, frames.length)}/${frames.length})`;
    job.progress = 25 + Math.round(
      ((i + batch.length) / frames.length) * 55
    );

    const content = [{
      type: "input_text",
      text: `
You are Afterimage, a video analysis system.

Analyze the supplied video frames in chronological order.
Each image is labeled with its timestamp.

USER'S QUESTION:
${question || "Identify meaningful activities, unusual behavior, interactions, and important events."}

Your task:
- Describe what is visibly happening.
- Identify meaningful changes in activity.
- Notice interactions between people and objects.
- Identify potentially important events relevant to the user's question.
- Connect observations across consecutive frames when the images support doing so.
- Distinguish direct visual observations from interpretations.
- Do not invent actions that are not visible.
- Do not identify people or guess their identities.
- Do not claim that someone committed a crime based only on ambiguous behavior.
- If something is uncertain, clearly state that it is uncertain.
- Ignore ordinary movement unless it is relevant to the question.

Return JSON only, in this format:

{
  "events": [
    {
      "timestamp": 120,
      "start": 115,
      "end": 130,
      "title": "Short descriptive event title",
      "description": "Describe only what can be observed in the frames.",
      "evidence": "Explain which visible details support this observation.",
      "reason": "Why this moment may be important.",
      "importanceScore": 80,
      "confidence": 0.85
    }
  ]
}

Timestamps must use seconds from the ORIGINAL video.
Only return events supported by the supplied images.
Use a reasonable time range around the observed activity.
Return no more than 5 events per batch.
importanceScore must be 0-100.
confidence must be between 0 and 1.
If there are no meaningful events, return an empty events array.
`
    }];

    for (const frame of batch) {
      const imageBase64 = fs.readFileSync(frame.path).toString("base64");

      content.push({
        type: "input_text",
        text: `Frame timestamp: ${frame.time} (${frame.timestamp} seconds)`
      });

      content.push({
        type: "input_image",
        image_url: `data:image/jpeg;base64,${imageBase64}`,
        detail: "low"
      });
    }

    const response = await openai.responses.create({
      model: MODEL,
      input: [{
        role: "user",
        content
      }]
    });

    const parsed = extractJson(response.output_text);

    for (const item of parsed.events || []) {
      const timestamp = Number(item.timestamp);
      const proposedStart = Number(item.start);
      const proposedEnd = Number(item.end);

      if (!Number.isFinite(timestamp)) continue;

      const eventStart = Math.max(
        rangeStart,
        Number.isFinite(proposedStart) ? proposedStart : timestamp - 5
      );

      const eventEnd = Math.min(
        rangeEnd,
        Number.isFinite(proposedEnd) ? proposedEnd : timestamp + 5
      );

      if (
        timestamp < rangeStart ||
        timestamp > rangeEnd ||
        eventEnd <= eventStart
      ) continue;

      candidates.push({
        timestamp,
        start: eventStart,
        end: eventEnd,
        time: safeTimestamp(eventStart),
        endTime: safeTimestamp(eventEnd),
        title: String(item.title || "Observed event"),
        description: String(item.description || ""),
        evidence: String(item.evidence || ""),
        hook: "",
        reason: String(item.reason || ""),
        importanceScore: Math.max(
          0,
          Math.min(100, Number(item.importanceScore) || 0)
        ),
        confidence: Math.max(
          0,
          Math.min(1, Number(item.confidence) || 0)
        ),
        mode: "visual-ai"
      });
    }
  }

  // Remove events that substantially overlap.
  candidates.sort((a, b) => b.importanceScore - a.importanceScore);

  const selected = [];

  for (const candidate of candidates) {
    const overlaps = selected.some(existing =>
      Math.max(candidate.start, existing.start) <
      Math.min(candidate.end, existing.end)
    );

    if (!overlaps) selected.push(candidate);
  }

  return selected.sort((a, b) => a.start - b.start);
}


function createSrt(segments, clipStart, clipEnd) {
  const relevant = segments.filter(s =>
    s.end > clipStart && s.start < clipEnd
  );

  return relevant.map((segment, index) => {
    const start = Math.max(0, segment.start - clipStart);
    const end = Math.max(start + 0.1, Math.min(clipEnd, segment.end) - clipStart);

    return `${index + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${segment.text}`;
  }).join("\n\n");
}


async function createClip(videoPath, event, job, videoIndex) {
  const clipId = uuidv4();
  const outputPath = path.join(OUTPUT_DIR, `${clipId}.mp4`);
  const captionPath = path.join(OUTPUT_DIR, `${clipId}.srt`);

  const videoResult = job.results[videoIndex];

  const duration = Number(videoResult?.duration);
  const timestamp = Number(
    event.timestamp ?? event.start ?? event.time
  );

  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new Error("The event timestamp is invalid.");
  }

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("The original video duration is unavailable.");
  }

  const clipDuration = Math.min(25, duration);

  let start = Math.max(0, timestamp - 12);
  let end = start + clipDuration;

  if (end > duration) {
    end = duration;
    start = Math.max(0, end - clipDuration);
  }

  if (end <= start) {
    throw new Error("Invalid clip boundaries.");
  }

  await runCommand(ffmpeg, [
    "-y",
    "-hide_banner",
    "-loglevel", "error",
    "-i", videoPath,
    "-ss", String(start),
    "-t", String(end - start),
    "-map", "0:v:0",
    "-map", "0:a?",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-movflags", "+faststart",
    outputPath
  ]);

  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
    throw new Error("FFmpeg did not produce a valid video clip.");
  }

  const srt = createSrt(
    videoResult.transcript || [],
    start,
    end
  );

  fs.writeFileSync(captionPath, srt, "utf8");

  return {
    id: clipId,
    url: `/output/${clipId}.mp4`,
    downloadUrl: `/output/${clipId}.mp4`,
    captionsUrl: `/output/${clipId}.srt`,
    start: safeTimestamp(start),
    end: safeTimestamp(end),
    duration: Math.round(end - start)
  };
}



async function processVideo(job, video, videoIndex, totalVideos) {
  const duration = await getVideoInfo(video.path);

  const start = parseTimestamp(job.settings.startTime || "00:00:00");

  const end = job.settings.endTime
    ? parseTimestamp(job.settings.endTime)
    : duration;

  if (start >= end || end > duration) {
    throw new Error(
      `Invalid time range. Video duration: ${safeTimestamp(duration)}`
    );
  }

  // Step 1: Transcribe audio.
  // A video with no speech can still be analyzed visually.
  let adjustedTranscript = [];

  try {
    job.stage = `Transcribing audio (${videoIndex + 1}/${totalVideos})`;

    const transcript = await transcribeVideo(
      video.path,
      end - start,
      job
    );

    adjustedTranscript = transcript.map(segment => ({
      ...segment,
      start: segment.start + start,
      end: segment.end + start
    }));
  } catch (error) {
    console.error("Audio transcription unavailable:", error.message);
    job.stage = "Continuing with visual analysis";
  }

  // Step 2: Extract actual video frames.
  const frames = await extractVideoFrames(
    video.path,
    start,
    end,
    job,
    videoIndex
  );

  if (!frames.length) {
    throw new Error("Could not extract frames from this video.");
  }

  // Step 3: Analyze the frames using AI vision.
  const visualEvents = await analyzeVisualFrames(
    frames,
    job.settings.question,
    start,
    end,
    job
  );

  // Step 4: Analyze speech separately when available.
  let transcriptEvents = [];

  if (adjustedTranscript.length) {
    transcriptEvents = await findHighlights(
      adjustedTranscript,
      job.settings.question,
      job
    );
  }

  // Step 5: Combine visual and audio findings.
  const combined = [
    ...visualEvents,
    ...transcriptEvents
  ];

  combined.sort((a, b) =>
    b.importanceScore - a.importanceScore
  );

  const finalEvents = [];

  for (const event of combined) {
    const overlaps = finalEvents.some(existing =>
      Math.max(event.start, existing.start) <
      Math.min(event.end, existing.end) * 0.85
    );

    if (!overlaps) {
      finalEvents.push({
        ...event,
        videoName: video.name,
        rangeStart: start,
        rangeEnd: end
      });
    }

    if (finalEvents.length >= MAX_HIGHLIGHTS) break;
  }

  finalEvents.sort((a, b) => a.start - b.start);

  return {
    videoName: video.name,
    duration,
    start,
    end,
    transcript: adjustedTranscript,
    transcriptText: transcriptToText(adjustedTranscript),
    events: finalEvents,
    analysis: {
      visualFramesAnalyzed: frames.length,
      visualEventsFound: visualEvents.length,
      transcriptEventsFound: transcriptEvents.length,
      visualAnalysisAvailable: true
    }
  };
}


async function processJob(job) {
  try {
    job.status = "processing";
    job.progress = 3;
    job.stage = "Preparing your video";

    const results = [];

    for (let i = 0; i < job.videos.length; i++) {
      const result = await processVideo(job, job.videos[i], i, job.videos.length);
      results.push(result);
    }

    job.stage = "Ranking the strongest moments";
    job.results = results;
    job.progress = 100;
    job.stage = "Ready to review";
    job.status = "completed";
    job.completedAt = new Date().toISOString();
  } catch (error) {
    job.status = "failed";
    job.stage = "Analysis failed";
    job.error = error.message;
    console.error(`[Afterimage job ${job.id}]`, error);
  }
}

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    visualAnalysisAvailable: Boolean(openai),
    visualAnalysisModel: MODEL,
    openAIConfigured: Boolean(openai),
    transcriptionAvailable: Boolean(openai),
    transcriptHighlightDetection: Boolean(openai),
    clipGenerationAvailable: Boolean(ffmpeg),
    youtubeDownloadAvailable: true,
    maxUploadMB: MAX_UPLOAD_MB,
    maxTranscriptionMinutes: MAX_TRANSCRIPTION_MINUTES,
    model: MODEL,
    transcriptionModel: TRANSCRIPTION_MODEL
  });
});

app.post("/api/analyze", upload.array("videos", 5), async (req, res) => {
  const videos = (req.files || []).map(file => ({
    name: file.originalname,
    path: file.path
  }));

  try {
    if (!openai) {
      throw new Error("OpenAI is not configured. Add OPENAI_API_KEY to your .env file.");
    }

    if (req.body.url) {
      const rawUrl = String(req.body.url).trim();
      let hostname;

      try {
        hostname = new URL(rawUrl).hostname.toLowerCase();
      } catch {
        throw new Error("Please provide a valid video URL.");
      }

      const youtubeHosts = ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"];
      const isYouTube = youtubeHosts.includes(hostname);
      const urlFile = path.join(UPLOAD_DIR, `${uuidv4()}.mp4`);

      if (isYouTube) {
        await downloadYouTubeVideo(rawUrl, urlFile);
        videos.push({ name: "YouTube video", path: urlFile });
      } else {
        await downloadVideo(rawUrl, urlFile);
        videos.push({ name: "Video from URL", path: urlFile });
      }
    }

    if (!videos.length) {
      throw new Error("Upload at least one video or provide a direct video URL.");
    }

    const job = {
      id: uuidv4(),
      status: "queued",
      progress: 0,
      stage: "Upload received",
      createdAt: new Date().toISOString(),
      videos,
      settings: {
        mode: "transcript-ai",
        question: String(req.body.question || ""),
        startTime: String(req.body.startTime || "00:00:00"),
        endTime: String(req.body.endTime || "")
      },
      results: []
    };

    jobs.set(job.id, job);

    res.status(202).json({
      id: job.id,
      status: job.status
    });

    processJob(job);
  } catch (error) {
    for (const video of videos) {
      try {
        if (fs.existsSync(video.path)) fs.unlinkSync(video.path);
      } catch {}
    }

    res.status(400).json({ error: error.message });
  }
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) return res.status(404).json({ error: "Job not found." });

  res.json({
    id: job.id,
    status: job.status,
    progress: job.progress,
    stage: job.stage || null,
    error: job.error || null
  });
});

app.get("/api/jobs/:id/results", (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) return res.status(404).json({ error: "Job not found." });

  if (job.status !== "completed") {
    return res.status(409).json({
      error: "Analysis is not complete.",
      status: job.status
    });
  }

  // Keep transcript available to the UI and clip caption generator.
  res.json({ results: job.results });
});

app.post("/api/jobs/:id/clips", async (req, res) => {
  try {
    const job = jobs.get(req.params.id);

    if (!job || job.status !== "completed") {
      return res.status(404).json({ error: "Completed job not found." });
    }

    const { videoIndex, eventIndex } = req.body;
    const vi = Number(videoIndex);
    const ei = Number(eventIndex);
    const videoResult = job.results[vi];
    const event = videoResult?.events?.[ei];

    if (!videoResult || !event) {
      return res.status(400).json({ error: "Highlight not found." });
    }

    const clip = await createClip(job.videos[vi].path, event, job, vi);
    res.json(clip);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) return res.status(404).json({ error: "Job not found." });

  for (const video of job.videos) {
    try {
      if (fs.existsSync(video.path)) fs.unlinkSync(video.path);
    } catch {}
  }

  jobs.delete(req.params.id);
  res.json({ success: true });
});

app.use((error, req, res, next) => {
  res.status(400).json({
    error: error.message || "Something went wrong."
  });
});

const CLIENT_DIST = path.join(__dirname, "../client/dist");

if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));

  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/") || req.path.startsWith("/output/")) {
      return next();
    }
    res.sendFile(path.join(CLIENT_DIST, "index.html"));
  });
}

app.listen(PORT, () => {
  console.log(`Afterimage backend running at http://localhost:${PORT}`);
});