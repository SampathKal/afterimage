
import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUpRight,
  Check,
  ChevronDown,
  Clock3,
  Download,
  FileVideo,
  Film,
  Menu,
  ScanEye,
  ShieldCheck,
  Sparkles,
  Upload,
  X,
  Activity,
  CircleHelp
} from "lucide-react";

const API = "";

function formatSize(bytes) {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const h = String(Math.floor(total / 3600)).padStart(2, "0");
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");

  return `${h}:${m}:${s}`;
}

function getErrorMessage(error, fallback) {
  return error instanceof Error && error.message
    ? error.message
    : fallback;
}

function App() {
  const analyzerRef = useRef(null);
  const fileInputRef = useRef(null);
  const uploadRequestRef = useRef(null);
  const pollingRef = useRef(false);

  const [menuOpen, setMenuOpen] = useState(false);
  const [files, setFiles] = useState([]);
  const [url, setUrl] = useState("");
  const [question, setQuestion] = useState("");
  const [mode, setMode] = useState("free");
  const [startTime, setStartTime] = useState("00:00:00");
  const [endTime, setEndTime] = useState("");
  const [jobId, setJobId] = useState(null);
  const [status, setStatus] = useState("idle");
  const [progress, setProgress] = useState(0);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [stage, setStage] = useState("");
  const [results, setResults] = useState([]);
  const [error, setError] = useState("");
  const [clips, setClips] = useState({});
  const [creatingClip, setCreatingClip] = useState(null);
  const [filter, setFilter] = useState("all");
  const [sortOrder, setSortOrder] = useState("high");
  const [health, setHealth] = useState(null);

  const isBusy = ["uploading", "queued", "processing"].includes(status);

  // Check backend connection
  useEffect(() => {
    let alive = true;

    fetch(`${API}/api/health`)
      .then(response => {
        if (!response.ok) {
          throw new Error("Health check failed.");
        }

        return response.json();
      })
      .then(data => {
        if (alive) {
          setHealth(data);
        }
      })
      .catch(() => {
        if (alive) {
          setHealth(null);
        }
      });

    return () => {
      alive = false;
    };
  }, []);

  // Poll analysis job and retrieve results before marking it completed.
  useEffect(() => {
    if (!jobId || !["queued", "processing"].includes(status)) {
      return;
    }

    let alive = true;

    const poll = async () => {
      if (pollingRef.current) {
        return;
      }

      pollingRef.current = true;

      try {
        const response = await fetch(`${API}/api/jobs/${jobId}`);
        const data = await response.json();

        if (!response.ok) {
          throw new Error(
            data.error || "Could not retrieve analysis status."
          );
        }

        if (!alive) return;

        setProgress(
          Number.isFinite(Number(data.progress))
            ? Math.max(0, Math.min(100, Number(data.progress)))
            : 0
        );

        if (data.stage) {
          setStage(data.stage);
        }

        if (data.status === "completed") {
          // Retrieve results BEFORE changing status.
          const resultResponse = await fetch(
            `${API}/api/jobs/${jobId}/results`
          );

          const resultData = await resultResponse.json();

          if (!resultResponse.ok) {
            throw new Error(
              resultData.error || "Could not retrieve results."
            );
          }

          if (!alive) return;

          if (!Array.isArray(resultData.results)) {
            throw new Error(
              "The server completed the analysis but returned results in an unexpected format."
            );
          }

          setResults(resultData.results);
          setProgress(100);
          setStage("Analysis complete");
          setStatus("completed");
        } else if (data.status === "failed") {
          setError(data.error || "Analysis failed.");
          setStage("Analysis failed");
          setStatus("failed");
        } else {
          setStatus(data.status || "processing");
        }
      } catch (err) {
        if (alive) {
          setError(
            getErrorMessage(
              err,
              "Could not retrieve analysis status."
            )
          );

          setStatus("failed");
          setStage("Analysis failed");
        }
      } finally {
        pollingRef.current = false;
      }
    };

    poll();

    const interval = setInterval(poll, 1500);

    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, [jobId, status]);

  // Cancel active upload when component unmounts
  useEffect(() => {
    return () => {
      uploadRequestRef.current?.abort();
    };
  }, []);

  const scrollToAnalyzer = () => {
    setMenuOpen(false);

    analyzerRef.current?.scrollIntoView({
      behavior: "smooth"
    });
  };

  // Add video files
  const addFiles = selected => {
    const allowed = [
      ".mp4",
      ".mov",
      ".webm",
      ".mkv",
      ".avi",
      ".m4v"
    ];

    const incoming = Array.from(selected || []);

    const valid = incoming.filter(file => {
      const ext = "." + file.name.split(".").pop()?.toLowerCase();
      return allowed.includes(ext);
    });

    const remainingSlots = Math.max(0, 5 - files.length);
    const accepted = valid.slice(0, remainingSlots);

    if (valid.length !== incoming.length) {
      setError(
        "Some files were skipped because their formats are unsupported."
      );
    } else if (accepted.length < valid.length) {
      setError(
        "Afterimage supports up to 5 video files per analysis."
      );
    } else {
      setError("");
    }

    setFiles(current => [...current, ...accepted].slice(0, 5));

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const removeFile = index => {
    setFiles(current =>
      current.filter((_, i) => i !== index)
    );
  };

  // Start analysis
  const analyze = () => {
    setError("");
    setResults([]);
    setClips({});
    setProgress(0);
    setUploadProgress(0);
    setStage("Preparing your request");
    setJobId(null);

    if (!files.length && !url.trim()) {
      setError("Upload a video or enter a video URL first.");
      setStatus("idle");
      return;
    }

    if (mode === "openai" && !health?.openAIConfigured) {
      setError(
        "OpenAI is not configured. Add your API key to the server .env file and restart the backend."
      );

      setStatus("idle");
      return;
    }

    const form = new FormData();

    files.forEach(file => {
      form.append("videos", file);
    });

    form.append("url", url.trim());
    form.append("question", question);
    form.append("mode", mode);
    form.append("startTime", startTime);
    form.append("endTime", endTime);

    setStatus("uploading");

    setStage(
      files.length
        ? "Uploading your video files"
        : "Submitting video URL"
    );

    const xhr = new XMLHttpRequest();

    uploadRequestRef.current = xhr;

    xhr.open("POST", `${API}/api/analyze`);
    xhr.responseType = "text";
    xhr.timeout = 10 * 60 * 1000;

    xhr.upload.onprogress = event => {
      if (!event.lengthComputable) return;

      const percent = Math.round((event.loaded / event.total) * 100);

      setUploadProgress(Math.max(0, Math.min(100, percent)));

      setStage(
        percent >= 100
          ? "Video sent. Server is saving and preparing it..."
          : `Uploading footage · ${percent}%`
      );
    };

    const finishUpload = () => {
      if (uploadRequestRef.current === xhr) {
        uploadRequestRef.current = null;
      }
    };

    xhr.onerror = () => {
      finishUpload();
      setStatus("failed");
      setStage("Connection failed");
      setError(
        "The connection to the server failed. Check that the backend is running and try again."
      );
    };

    xhr.ontimeout = () => {
      finishUpload();
      setStatus("failed");
      setStage("Upload timed out");
      setError(
        "The server took too long to accept this video. Try a smaller file or a shorter recording."
      );
    };

    xhr.onabort = () => {
      finishUpload();
      setStatus("idle");
      setStage("");
      setError("The upload was canceled.");
    };

    xhr.onload = () => {
      finishUpload();

      let data;

      try {
        data = JSON.parse(xhr.responseText || "{}");
      } catch {
        setStatus("failed");
        setStage("Invalid server response");
        setError(
          `The server returned an unreadable response (HTTP ${xhr.status}). Check the backend terminal.`
        );
        return;
      }

      if (xhr.status < 200 || xhr.status >= 300) {
        setStatus("failed");
        setStage("Could not start analysis");
        setError(data.error || `The server returned error ${xhr.status}.`);
        return;
      }

      if (!data.id) {
        setStatus("failed");
        setStage("Invalid server response");
        setError("The server did not return an analysis job ID.");
        return;
      }

      setJobId(data.id);
      setProgress(Number(data.progress) || 0);
      setStatus(data.status === "processing" ? "processing" : "queued");
      setStage(data.stage || "Video received. Preparing analysis...");
    };

    xhr.send(form);
  };

  // Generate a clip from an event
  const generateClip = async (videoIndex, eventIndex) => {
    const key = `${videoIndex}-${eventIndex}`;

    setCreatingClip(key);
    setError("");

    try {
      const response = await fetch(
        `${API}/api/jobs/${jobId}/clips`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            videoIndex,
            eventIndex
          })
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.error || "Clip generation failed."
        );
      }

      setClips(current => ({
        ...current,
        [key]: data
      }));
    } catch (err) {
      setError(
        getErrorMessage(err, "Clip generation failed.")
      );
    } finally {
      setCreatingClip(null);
    }
  };

  // Reset everything for a new analysis
  const startNewAnalysis = () => {
    uploadRequestRef.current?.abort();

    setStatus("idle");
    setJobId(null);
    setProgress(0);
    setUploadProgress(0);
    setStage("");
    setResults([]);
    setFiles([]);
    setUrl("");
    setQuestion("");
    setClips({});
    setError("");
    setFilter("all");
  };

  // Combine events from all videos
  const allEvents = results.flatMap((result, videoIndex) =>
    (result.events || []).map((event, eventIndex) => ({
      ...event,
      videoIndex,
      eventIndex
    }))
  );

  // Filter and sort events
const visibleEvents = allEvents
  .filter(event => {
    const score = Number(event.importanceScore) || 0;

    if (filter === "high") return score >= 70;
    if (filter === "medium") return score >= 40 && score < 70;
    if (filter === "low") return score < 40;

    return true;
  })
  .sort((a, b) => {
    const scoreA = Number(a.importanceScore) || 0;
    const scoreB = Number(b.importanceScore) || 0;

    return sortOrder === "high"
      ? scoreB - scoreA
      : scoreA - scoreB;
  });

  const progressValue =
    status === "uploading"
      ? uploadProgress
      : progress;

  const progressLabel =
    status === "uploading"
      ? uploadProgress >= 100
        ? "Upload complete. Waiting for server..."
        : "Uploading footage"
      : stage ||
        (status === "queued"
          ? "Preparing your footage"
          : "Analyzing video");

  return (
    <>
      <nav className="navbar">
        <a
          className="logo"
          href="#"
          onClick={() =>
            window.scrollTo({
              top: 0,
              behavior: "smooth"
            })
          }
        >
          Afterimage<span>.</span>
        </a>

        <div className="nav-right">
          <span className="nav-status">
            <i /> Visual intelligence
          </span>

          <button
            className={`menu-button ${menuOpen ? "active" : ""}`}
            onClick={() => setMenuOpen(!menuOpen)}
          >
            {menuOpen ? (
              <X size={17} />
            ) : (
              <Menu size={17} />
            )}

            <span>{menuOpen ? "Close" : "Menu"}</span>
          </button>
        </div>
      </nav>

      {menuOpen && (
        <div className="menu-overlay">
          <div className="menu-links">
            {[
              ["Product", "#product"],
              ["How it works", "#how"],
              ["Capabilities", "#capabilities"],
              ["FAQ", "#faq"]
            ].map(([label, href]) => (
              <a
                href={href}
                onClick={() => setMenuOpen(false)}
                key={label}
              >
                {label}
                <ArrowUpRight />
              </a>
            ))}

            <button onClick={scrollToAnalyzer}>
              Try Afterimage
              <ArrowUpRight />
            </button>
          </div>
        </div>
      )}

      <main>
        <section className="hero">
          <div className="hero-image" />
          <div className="hero-shade" />

          <div className="hero-lines left-lines">
            {Array.from({ length: 12 }, (_, i) => (
              <i
                key={i}
                style={{ "--i": i }}
              />
            ))}
          </div>

          <div className="hero-lines right-lines">
            {Array.from({ length: 12 }, (_, i) => (
              <i
                key={i}
                style={{ "--i": i }}
              />
            ))}
          </div>

          <div className="hero-content">
            <div className="eyebrow light">
              <span className="live-dot" /> A new way to understand footage
            </div>

            <h1>
              Every moment,
              <br />
              <em>made clear.</em>
            </h1>

            <p>
              Turn long recordings into clear timelines, meaningful moments,
              and evidence-backed video clips.
            </p>

            <div className="hero-actions">
              <button
                className="button button-white"
                onClick={scrollToAnalyzer}
              >
                Analyze footage <ArrowUpRight size={17} />
              </button>

              <a className="hero-secondary" href="#how">
                See how it works <ArrowDown size={15} />
              </a>
            </div>
          </div>

          <div className="hero-bottom">
            <span>VIDEO INTELLIGENCE / 01</span>
            <span>OBSERVE. UNDERSTAND. REVIEW.</span>
          </div>
        </section>

        <div className="ticker">
          <div className="ticker-track">
            {Array.from({ length: 2 }, (_, i) => (
              <div className="ticker-group" key={i}>
                {[
                  "Video Intelligence",
                  "Event Detection",
                  "Evidence Clips",
                  "Timeline Analysis",
                  "Visual Memory"
                ].map(item => (
                  <span key={item}>
                    {item}
                    <b>✳</b>
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>

        <section className="intro section-pad" id="product">
          <div className="section-kicker">01 / THE PRODUCT</div>

          <div className="intro-grid">
            <h2>
              Hours of footage.
              <br />
              <em>Clarity in moments.</em>
            </h2>

            <div className="intro-copy">
              <p>
                Afterimage helps you find the moments that matter in a video.
                Instead of manually scrubbing through hours of footage, you
                can analyze a recording, review a timeline, and create clips
                around selected events.
              </p>

              <button
                className="text-link"
                onClick={scrollToAnalyzer}
              >
                Explore the analyzer <ArrowUpRight size={17} />
              </button>
            </div>
          </div>
        </section>

        <section className="steps-section section-pad" id="how">
          <div className="section-heading">
            <div className="section-kicker">02 / HOW IT WORKS</div>

            <h2>
              From recording to <em>understanding.</em>
            </h2>
          </div>

          <div className="steps-grid">
            {[
              {
                n: "01",
                icon: Upload,
                title: "Add your footage",
                text: "Upload one or multiple video files, or provide a supported public direct video URL."
              },
              {
                n: "02",
                icon: ScanEye,
                title: "Define what matters",
                text: "Tell Afterimage what you want to find. Your question helps guide the analysis."
              },
              {
                n: "03",
                icon: Activity,
                title: "Analyze the recording",
                text: "Afterimage samples frames, detects changes, and identifies candidate events."
              },
              {
                n: "04",
                icon: Film,
                title: "Review the moments",
                text: "Explore timestamps, understand why events were selected, and generate video clips."
              }
            ].map(({ n, icon: Icon, title, text }) => (
              <article className="step-card" key={n}>
                <div className="step-top">
                  <span>{n}</span>
                  <Icon size={21} />
                </div>

                <h3>{title}</h3>
                <p>{text}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="capabilities section-pad" id="capabilities">
          <div className="capability-copy">
            <div className="section-kicker">03 / CAPABILITIES</div>

            <h2>
              More than a
              <br />
              <em>play button.</em>
            </h2>

            <p>
              Afterimage is designed to help you move from a long recording
              to a useful review. Every finding should have a timestamp,
              an explanation, and a link back to its source footage.
            </p>
          </div>

          <div className="capability-list">
            <div>
              <Clock3 />
              <span>
                <b>Timestamped events</b>
                <small>Review candidate events in chronological order.</small>
              </span>
            </div>

            <div>
              <Sparkles />
              <span>
                <b>Two analysis modes</b>
                <small>
                  Start with free visual-change detection or use OpenAI vision
                  analysis.
                </small>
              </span>
            </div>

            <div>
              <Film />
              <span>
                <b>Generated clips</b>
                <small>Create actual MP4 clips around selected events.</small>
              </span>
            </div>

            <div>
              <ShieldCheck />
              <span>
                <b>Evidence and uncertainty</b>
                <small>
                  See why a moment was selected and what the model cannot
                  determine.
                </small>
              </span>
            </div>
          </div>
        </section>

        <section
          className="analyzer-section section-pad"
          ref={analyzerRef}
          id="analyzer"
        >
          <div className="analyzer-heading">
            <div>
              <div className="section-kicker">04 / THE ANALYZER</div>

              <h2>
                Give your footage <em>a second look.</em>
              </h2>

              <p>
                Upload a recording, tell us what to look for, and start an
                analysis.
              </p>
            </div>

            <div className="availability">
              <i />
              {health ? "Backend connected" : "Checking connection"}
            </div>
          </div>

          <div className="analyzer-panel">
            <div className="panel-top">
              <div>
                <span className="panel-label">NEW ANALYSIS</span>
                <h3>Start with your footage</h3>
              </div>

              <span className="panel-number">AF / 001</span>
            </div>

            <div
              className="upload-area"
              onDragOver={e => e.preventDefault()}
              onDrop={e => {
                e.preventDefault();
                addFiles(e.dataTransfer.files);
              }}
              onClick={() => fileInputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={e => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="video/mp4,video/quicktime,video/webm,video/x-matroska,video/x-msvideo,.m4v"
                multiple
                hidden
                onChange={e => {
                  if (e.target.files) {
                    addFiles(e.target.files);
                  }
                }}
              />

              <div className="upload-icon">
                <Upload size={21} />
              </div>

              <b>Drop your videos here</b>
              <span>or browse files · MP4, MOV, WebM, MKV, AVI</span>

              <small>
                Up to 5 files · Maximum {health?.maxUploadMB || 500} MB each
              </small>
            </div>

            {files.length > 0 && (
              <div className="file-list">
                {files.map((file, index) => (
                  <div
                    className="file-row"
                    key={`${file.name}-${index}`}
                  >
                    <FileVideo size={18} />

                    <div>
                      <b>{file.name}</b>
                      <small>{formatSize(file.size)}</small>
                    </div>

                    <button
                      onClick={() => removeFile(index)}
                      aria-label={`Remove ${file.name}`}
                      type="button"
                    >
                      <X size={16} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="form-divider">
              <span>OR USE A VIDEO URL</span>
            </div>

            <label className="field-label" htmlFor="video-url">
              Video URL
            </label>

            <input
              id="video-url"
              className="text-input"
              value={url}
              onChange={e => setUrl(e.target.value)}
              placeholder="https://example.com/recording.mp4"
            />

            <p className="field-hint">
              Use a supported public video link. Private pages and many
              streaming-site links may not work. Only submit videos you own or
              have permission to analyze.
            </p>

            <div className="form-divider">
              <span>ANALYSIS SETTINGS</span>
            </div>

            <label className="field-label" htmlFor="question">
              What should Afterimage look for?
            </label>

            <textarea
              id="question"
              className="text-input question-input"
              value={question}
              onChange={e => setQuestion(e.target.value)}
              placeholder="Example: Find when an object moves or when something enters the visible area."
              rows={3}
            />

            <div className="range-grid">
              <div>
                <label className="field-label" htmlFor="start-time">
                  Start time
                </label>

                <input
                  id="start-time"
                  className="text-input"
                  value={startTime}
                  onChange={e => setStartTime(e.target.value)}
                  placeholder="00:00:00"
                />
              </div>

              <div>
                <label className="field-label" htmlFor="end-time">
                  End time
                </label>

                <input
                  id="end-time"
                  className="text-input"
                  value={endTime}
                  onChange={e => setEndTime(e.target.value)}
                  placeholder="End of video"
                />
              </div>
            </div>

            <p className="field-hint">
              Use HH:MM:SS. Leave the end time blank to analyze to the end.
            </p>

            <div className="form-divider">
              <span>CHOOSE YOUR ANALYSIS MODE</span>
            </div>

            <div className="mode-grid">
              <button
                className={`mode-card ${mode === "free" ? "selected" : ""}`}
                onClick={() => setMode("free")}
                type="button"
              >
                <div className="mode-icon">
                  <Activity />
                </div>

                <div className="mode-title">
                  Free Analysis
                  {mode === "free" && <Check size={16} />}
                </div>

                <p>
                  Local frame comparison and visual-change detection. No API
                  key required.
                </p>

                <span className="mode-tag">FREE</span>
              </button>

              <button
                className={`mode-card ${mode === "openai" ? "selected" : ""}`}
                onClick={() => setMode("openai")}
                type="button"
              >
                <div className="mode-icon">
                  <Sparkles />
                </div>

                <div className="mode-title">
                  OpenAI Analysis
                  {mode === "openai" && <Check size={16} />}
                </div>

                <p>
                  AI interpretation of sampled frames, guided by your question.
                </p>

                <span className="mode-tag">API KEY REQUIRED</span>
              </button>
            </div>

            {mode === "openai" && !health?.openAIConfigured && (
              <div className="notice">
                OpenAI is not configured yet. Add your API key to the server's
                .env file and restart the backend.
              </div>
            )}

            {error && (
              <div className="error-message" role="alert">
                {error}
              </div>
            )}

            <button
              className="button analyze-button"
              onClick={analyze}
              disabled={isBusy}
              type="button"
            >
              {isBusy ? (
                <>
                  {status === "uploading"
                    ? "Sending footage"
                    : "Analyzing footage"}

                  <span className="spinner" />
                </>
              ) : (
                <>
                  Start analysis <ArrowUpRight size={17} />
                </>
              )}
            </button>

            {isBusy && (
              <div className="progress-area" aria-live="polite">
                <div className="progress-top">
                  <span>{progressLabel}</span>

                  <b>
                    {status === "uploading"
                      ? `${uploadProgress}%`
                      : `${progress}%`}
                  </b>
                </div>

                <div className="progress-track">
                  <i style={{ width: `${progressValue}%` }} />
                </div>

                <small>
                  {status === "uploading"
                    ? "Large files may take a while to upload. Keep this page open."
                    : "Keep this page open while the analysis runs."}
                </small>
              </div>
            )}
          </div>

          {status === "completed" && (
            <div className="results-section">
              <div className="results-heading">
                <div>
                  <div className="section-kicker">ANALYSIS COMPLETE</div>

                  <h3>
                    Your footage, <em>reviewed.</em>
                  </h3>

                  <p>
                    {allEvents.length} candidate events across {results.length}{" "}
                    video(s).
                  </p>
                </div>

                <button
                  className="button button-outline"
                  onClick={startNewAnalysis}
                  type="button"
                >
                  New analysis
                </button>
              </div>

              {results.map((result, videoIndex) => (
                <div className="video-result" key={videoIndex}>
                  <div className="video-result-top">
                    <FileVideo size={19} />

                    <div>
                      <b>{result.videoName}</b>

                      <small>
                        Duration: {formatTime(result.duration)}
                      </small>
                    </div>
                  </div>
                </div>
              ))}

              <div className="timeline-heading">
                <h3>Event timeline</h3>

                <div className="filter-row">
  {["all", "high", "medium", "low"].map(value => (
    <button
      key={value}
      className={filter === value ? "filter-active" : ""}
      onClick={() => setFilter(value)}
      type="button"
    >
      {value === "all"
        ? "All"
        : value[0].toUpperCase() + value.slice(1)}
    </button>
  ))}

  <button
    className="sort-button"
    onClick={() =>
      setSortOrder(current =>
        current === "high" ? "low" : "high"
      )
    }
    type="button"
  >
    {sortOrder === "high"
      ? "↓ Highest importance"
      : "↑ Lowest importance"}
  </button>
</div>
              </div>

              <div className="timeline-list">
                {visibleEvents.map(event => {
                  const key = `${event.videoIndex}-${event.eventIndex}`;
                  const clip = clips[key];

                  return (
                    <article className="event-card" key={key}>
                      <div className="event-marker">
                        <i />
                      </div>

                      <div className="event-content">
                        <div className="event-meta">
                          <span className="event-time">
                            <Clock3 size={14} /> {event.time}
                          </span>

                          <span className="score">
                            Importance {event.importanceScore}/100
                          </span>

                          <span className="confidence">
                            Confidence{" "}
                            {Math.round(
                              (Number(event.confidence) || 0) * 100
                            )}
                            %
                          </span>
                        </div>

                        <h4>{event.description}</h4>

                        <p className="event-reason">
                          <b>Why selected:</b> {event.reason}
                        </p>

                        <p className="event-uncertainty">
                          <b>Uncertainty:</b> {event.uncertainty}
                        </p>

                        <div className="event-actions">
                          <button
                            className="small-button"
                            onClick={() =>
                              generateClip(
                                event.videoIndex,
                                event.eventIndex
                              )
                            }
                            disabled={creatingClip === key}
                            type="button"
                          >
                            <Film size={15} />

                            {creatingClip === key
                              ? "Creating clip..."
                              : "Generate clip"}
                          </button>
                        </div>

                        {clip && (
                          <div className="clip-result">
                            <div className="clip-heading">
                              <Check size={16} /> Clip created
                            </div>

                            <video controls src={clip.url} />

                            <a href={clip.downloadUrl} download>
                              <Download size={15} /> Download MP4
                            </a>
                          </div>
                        )}
                      </div>
                    </article>
                  );
                })}

                {!visibleEvents.length && (
                  <div className="empty-results">
                    {allEvents.length === 0
                      ? "The analysis completed, but no candidate events were returned. Check the backend analysis results."
                      : "No events match this filter."}
                  </div>
                )}
              </div>

              <p className="results-disclaimer">
                These are AI-generated observations, not definitive evidence.
                Review the original footage before drawing conclusions.
              </p>
            </div>
          )}

          {status === "failed" && (
            <div className="results-disclaimer">
              The analysis did not complete. Review the error above and check
              the backend terminal for more detail.
            </div>
          )}
        </section>

        <section className="limitations section-pad">
          <div className="section-kicker">05 / BUILT WITH TRANSPARENCY</div>

          <h2>
            Useful insights.
            <br />
            <em>Honest limitations.</em>
          </h2>

          <div className="limitations-grid">
            <div>
              <ShieldCheck />
              <h3>Evidence first</h3>
              <p>
                Findings should connect to sampled frames and timestamps, not
                unsupported assumptions.
              </p>
            </div>

            <div>
              <CircleHelp />
              <h3>Not infallible</h3>
              <p>
                Lighting, camera angles, resolution, and missed frames can
                affect what the system detects.
              </p>
            </div>

            <div>
              <ScanEye />
              <h3>Observable events</h3>
              <p>
                Afterimage does not identify people, determine intent, or
                assign blame.
              </p>
            </div>
          </div>
        </section>

        <section className="faq-section section-pad" id="faq">
          <div className="section-kicker">06 / QUESTIONS</div>

          <h2>
            Frequently asked <em>questions.</em>
          </h2>

          {[
            [
              "What video formats are supported?",
              "The application accepts MP4, MOV, WebM, MKV, AVI, and M4V uploads. Actual decoding depends on the installed FFmpeg build and the video's codec."
            ],
            [
              "What is the difference between Free and OpenAI Analysis?",
              "Free Analysis compares sampled frames to detect visual changes and movement. OpenAI Analysis sends sampled frames to a vision-capable model to describe visible events in relation to your question."
            ],
            [
              "Can I analyze a two-hour recording?",
              "The backend has a configurable duration limit. Longer recordings take more time to process. You can select a smaller time range to focus on a section."
            ],
            [
              "Can I download clips?",
              "Yes. Select Generate clip on an event. Afterimage uses FFmpeg to create an MP4 from the original recording."
            ],
            [
              "Does Afterimage identify people?",
              "No. It is designed for observable events and changes, not face recognition or identity tracking."
            ],
            [
              "Does OpenAI usage cost money?",
              "OpenAI API usage is billed separately from a ChatGPT subscription. Free Analysis does not require an OpenAI API key."
            ]
          ].map(([faqQuestion, answer]) => (
            <details className="faq-item" key={faqQuestion}>
              <summary>
                {faqQuestion}
                <ChevronDown size={18} />
              </summary>

              <p>{answer}</p>
            </details>
          ))}
        </section>

        <section className="closing-cta">
          <div className="section-kicker light">
            AFTERIMAGE / VISUAL MEMORY
          </div>

          <h2>
            Look closer.
            <br />
            <em>Understand more.</em>
          </h2>

          <button
            className="button button-white"
            onClick={scrollToAnalyzer}
            type="button"
          >
            Analyze your footage <ArrowUpRight size={17} />
          </button>
        </section>
      </main>

      <footer className="footer">
        <a className="logo" href="#">
          Afterimage<span>.</span>
        </a>

        <span>Every moment, made clear.</span>

        <span>© {new Date().getFullYear()} Afterimage</span>
      </footer>
    </>
  );
}

export default App;
