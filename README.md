# Afterimage

AI-powered video analysis and event timeline application.

## Requirements

- Windows 10 or 11
- Node.js 20 or newer
- Internet connection for installing dependencies
- OpenAI API key for OpenAI Analysis (optional)

FFmpeg is installed through the ffmpeg-static npm package.

## Installation

1. Extract the Afterimage ZIP.
2. Open the afterimage folder in Visual Studio Code.
3. Open the VS Code terminal.
4. Run:

   npm install

5. Install frontend dependencies:

   npm install --prefix client

6. Copy `.env.example` and rename the copy to `.env`.
7. Leave OPENAI_API_KEY blank if you only want Free Analysis.

## Starting the application

Double-click `start.bat`.

Alternatively, run:

npm run dev

Open:

http://localhost:5173

## Free Analysis

Free Analysis uses FFmpeg to extract sampled frames and Sharp to compare
their visual differences.

It can identify candidate moments with noticeable visual changes.

It does not reliably understand the meaning of a scene.

## OpenAI Analysis

1. Create an OpenAI API key.
2. Put it in the `.env` file:

   OPENAI_API_KEY=your_key_here

3. Set the model:

   OPENAI_MODEL=gpt-4.1-mini

4. Restart the backend.

OpenAI API usage is billed separately from ChatGPT subscriptions.

## Video uploads

Supported extensions:

- MP4
- MOV
- WebM
- MKV
- AVI
- M4V

Actual codec support depends on FFmpeg.

## Video URLs

Use publicly accessible direct video-file URLs.

A normal webpage URL, private video, or streaming service page may not work.

## Clip generation

After analysis:

1. Find an event in the timeline.
2. Select Generate clip.
3. Wait for FFmpeg to process the clip.
4. Preview or download the MP4.

## Important limitations

- Jobs are stored in memory and disappear when the server restarts.
- This prototype does not provide persistent user accounts.
- Long recordings take longer to analyze.
- OpenAI analysis uses sampled frames, not continuous human-level video observation.
- Free Analysis detects visual differences, not semantic events.
- The direct URL downloader needs additional security hardening before public deployment.
- This is an analysis assistant, not a definitive evidence or surveillance system.

Use staged or consented recordings when testing.
