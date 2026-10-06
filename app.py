r"""
FlowFlix — Netflix-style Streaming Server for E:\Movies

Features:
  - Recursive auto-indexing of E:\Movies and all subfolders
  - Advanced filename metadata parser (Title, Year, Quality, Audio, Codec, Season/Episode)
  - TMDB Poster Fetch & Local Disk Caching + FFmpeg 10-min mark Fallback Thumbnail Generator
  - Multi-Audio Track Detection & Dynamic FFmpeg Audio Track Remuxing
  - HTTP Range-request video streaming with fast seeking
  - Direct file download endpoint with Original Filename Preservation
  - Subtitle auto-detection & SRT to WebVTT conversion on the fly
  - Screen Rotation Button for Fullscreen Mobile / Desktop
  - Netflix dark theme UI (Mobile & PC supported)
  - 0.0.0.0 binding for local network WiFi access
"""

import os
import re
import json
import hashlib
import socket
import subprocess
import shutil
import threading
from datetime import datetime, timezone
from urllib.parse import unquote, quote
import urllib.request
import urllib.parse
import qrcode

from flask import Flask, abort, render_template, request, send_file, Response, jsonify

# ---------------------------------------------------------------------------
# Configuration & Paths
# ---------------------------------------------------------------------------

HOST = "0.0.0.0"
PORT = 5000

MOVIES_ROOT = os.path.abspath(r"E:\Movies")
APP_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_FOLDER = os.path.join(APP_DIR, "uploads")
METADATA_FILE = os.path.join(UPLOAD_FOLDER, "metadata.json")
POSTER_CACHE_DIR = os.path.join(UPLOAD_FOLDER, "cache", "posters")

ALLOWED_VIDEO_EXTENSIONS = {".mp4", ".mkv", ".webm", ".avi", ".mov", ".m4v", ".mp3"}
ALLOWED_SUB_EXTENSIONS = {".srt", ".vtt"}

# Locate FFmpeg & FFprobe binaries
FFMPEG_BIN = shutil.which("ffmpeg") or "ffmpeg"
FFPROBE_BIN = shutil.which("ffprobe") or "ffprobe"

TMDB_API_KEY = "15d2fb603077b72163e2776c5b058c97"

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 10 * 1024 * 1024 * 1024  # 10 GB limit

_library = []
_folders = []
_lock = threading.Lock()

# ---------------------------------------------------------------------------
# Helpers & Network IPs
# ---------------------------------------------------------------------------

def get_local_ips():
    ips = []
    try:
        hostname = socket.gethostname()
        for ip in socket.gethostbyname_ex(hostname)[2]:
            if not ip.startswith("127."):
                ips.append(ip)
    except Exception:
        pass
    if not ips:
        ips.append("127.0.0.1")
    return ips


def format_size(bytes_size):
    if bytes_size < 1024:
        return f"{bytes_size} B"
    elif bytes_size < 1024 * 1024:
        return f"{bytes_size / 1024:.1f} KB"
    elif bytes_size < 1024 * 1024 * 1024:
        return f"{bytes_size / (1024 * 1024):.1f} MB"
    else:
        return f"{bytes_size / (1024 * 1024 * 1024):.2f} GB"


def get_video_hash(rel_path):
    """Generate MD5 hash string for video relative path."""
    return hashlib.md5(rel_path.replace("\\", "/").encode("utf-8")).hexdigest()

# ---------------------------------------------------------------------------
# TMDB & FFmpeg Poster Thumbnail Engine
# ---------------------------------------------------------------------------

def generate_ffmpeg_thumbnail(filepath, cache_path):
    """Use FFmpeg to extract a video thumbnail at the 10-min mark (or earlier if short)."""
    duration = 0
    try:
        # Get video duration via FFprobe
        cmd_prob = [
            FFPROBE_BIN, "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            filepath
        ]
        res = subprocess.run(cmd_prob, capture_output=True, text=True, timeout=5)
        if res.returncode == 0 and res.stdout.strip():
            duration = float(res.stdout.strip())
    except Exception as e:
        print(f"FFprobe duration check error: {e}")

    # Determine timestamp (10 min mark = 600s)
    if duration >= 600:
        ss_time = "00:10:00"
    elif duration > 30:
        ss_time = "00:00:10"
    else:
        ss_time = "00:00:01"

    try:
        cmd_ff = [
            FFMPEG_BIN, "-y",
            "-ss", ss_time,
            "-i", filepath,
            "-vframes", "1",
            "-q:v", "2",
            cache_path
        ]
        subprocess.run(cmd_ff, capture_output=True, text=True, timeout=10)
        return os.path.exists(cache_path) and os.path.getsize(cache_path) > 0
    except Exception as e:
        print(f"FFmpeg thumbnail extraction error: {e}")
        return False


def fetch_tmdb_poster(clean_title, category, year):
    """Ping TMDB search API to retrieve movie/tv poster image URL."""
    endpoint = "tv" if category == "TV Show" else "movie"
    query_str = urllib.parse.quote(clean_title)
    url = f"https://api.themoviedb.org/3/search/{endpoint}?api_key={TMDB_API_KEY}&query={query_str}"
    if year:
        url += f"&year={year}"

    try:
        req = urllib.request.Request(url, headers={"User-Agent": "FlowFlix/1.0"})
        with urllib.request.urlopen(req, timeout=3) as resp:
            if resp.status == 200:
                data = json.loads(resp.read().decode("utf-8"))
                results = data.get("results", [])
                if results and results[0].get("poster_path"):
                    poster_path = results[0]["poster_path"]
                    return f"https://image.tmdb.org/t/p/w500{poster_path}"
    except Exception:
        pass
    return None


def get_or_create_poster(filepath, rel_path, clean_title, category, year):
    """Retrieve poster from cache, or download from TMDB, or fallback to FFmpeg 10-min frame."""
    os.makedirs(POSTER_CACHE_DIR, exist_ok=True)
    v_hash = get_video_hash(rel_path)
    cache_path = os.path.join(POSTER_CACHE_DIR, f"{v_hash}.jpg")

    if os.path.exists(cache_path) and os.path.getsize(cache_path) > 0:
        return cache_path

    # 1. Try TMDB
    poster_url = fetch_tmdb_poster(clean_title, category, year)
    if poster_url:
        try:
            req = urllib.request.Request(poster_url, headers={"User-Agent": "FlowFlix/1.0"})
            with urllib.request.urlopen(req, timeout=4) as resp:
                if resp.status == 200:
                    with open(cache_path, "wb") as f:
                        f.write(resp.read())
                    return cache_path
        except Exception as e:
            print(f"TMDB download error: {e}")

    # 2. Fallback to FFmpeg thumbnail
    if generate_ffmpeg_thumbnail(filepath, cache_path):
        return cache_path

    return None

# ---------------------------------------------------------------------------
# FFmpeg Multi-Audio Track Engine
# ---------------------------------------------------------------------------

def get_audio_tracks(filepath):
    """Inspect file for multiple audio streams using FFprobe."""
    tracks = []
    try:
        cmd = [
            FFPROBE_BIN, "-v", "error",
            "-show_entries", "stream=index,codec_name,channels:stream_tags=language,title",
            "-select_streams", "a",
            "-of", "json",
            filepath
        ]
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
        if res.returncode == 0:
            data = json.loads(res.stdout)
            streams = data.get("streams", [])
            for idx, s in enumerate(streams):
                tags = s.get("tags", {})
                lang = tags.get("language", f"Track {idx+1}")
                title = tags.get("title", f"Audio {idx+1}")
                channels = s.get("channels", 2)
                
                lang_name = lang.upper()
                if lang.lower() in ("hin", "hindi"): lang_name = "Hindi"
                elif lang.lower() in ("eng", "english"): lang_name = "English"
                elif lang.lower() in ("tam", "tamil"): lang_name = "Tamil"
                elif lang.lower() in ("tel", "telugu"): lang_name = "Telugu"

                tracks.append({
                    "id": idx,
                    "stream_index": s.get("index"),
                    "codec": s.get("codec_name", "aac"),
                    "language": lang_name,
                    "title": f"{lang_name} ({channels}ch)" if title == "Audio "+str(idx+1) else f"{title} - {lang_name}",
                    "channels": channels
                })
    except Exception as e:
        print(f"Audio track probe error: {e}")

    if not tracks:
        tracks.append({
            "id": 0,
            "stream_index": 1,
            "codec": "aac",
            "language": "Default Audio",
            "title": "Default Track",
            "channels": 2
        })
    return tracks

# ---------------------------------------------------------------------------
# Metadata Extractor
# ---------------------------------------------------------------------------

def parse_video_metadata(filepath, rel_path):
    filename = os.path.basename(filepath)
    name_without_ext = os.path.splitext(filename)[0]

    title = name_without_ext
    year = ""
    quality = ""
    audio = ""
    codec = ""
    season_episode = ""
    category = "Movie"

    # Season / Episode
    se_match = re.search(r'\b(S\d{1,2}(?:E\d{1,2})?)\b', name_without_ext, re.I)
    if se_match:
        season_episode = se_match.group(1).upper()
        category = "TV Show"

    # Year
    year_match = re.search(r'\b(19\d{2}|20[0-3]\d)\b', name_without_ext)
    if year_match:
        year = year_match.group(1)

    # Quality
    qualities = []
    if re.search(r'\b(2160p|4k|uhd)\b', name_without_ext, re.I): qualities.append("4K UHD")
    elif re.search(r'\b(1080p)\b', name_without_ext, re.I): qualities.append("1080p")
    elif re.search(r'\b(720p)\b', name_without_ext, re.I): qualities.append("720p")

    if re.search(r'\b(10bit)\b', name_without_ext, re.I): qualities.append("10Bit")

    if re.search(r'\b(bluray|brrip)\b', name_without_ext, re.I): qualities.append("BluRay")
    elif re.search(r'\b(web-dl|webrip|web)\b', name_without_ext, re.I): qualities.append("WEB-DL")
    elif re.search(r'\b(hdtv)\b', name_without_ext, re.I): qualities.append("HDTV")

    quality = " ".join(qualities) if qualities else "HD"

    # Audio tags
    audio_tags = []
    if re.search(r'\b(hindi)\b', name_without_ext, re.I): audio_tags.append("Hindi")
    if re.search(r'\b(english)\b', name_without_ext, re.I): audio_tags.append("English")
    if re.search(r'\b(tamil)\b', name_without_ext, re.I): audio_tags.append("Tamil")
    if re.search(r'\b(telugu)\b', name_without_ext, re.I): audio_tags.append("Telugu")

    audio = " + ".join(audio_tags) if len(audio_tags) > 1 else (audio_tags[0] if audio_tags else "")
    if re.search(r'\b(dual[-. ]audio)\b', name_without_ext, re.I) and not audio:
        audio = "Dual Audio"

    if re.search(r'\b(5\.1|dd5\.1)\b', name_without_ext, re.I):
        audio += " 5.1" if audio else "5.1"

    # Codec
    if re.search(r'\b(x265|hevc|h265)\b', name_without_ext, re.I): codec = "HEVC / x265"
    elif re.search(r'\b(x264|h264)\b', name_without_ext, re.I): codec = "x264"

    # Clean title
    clean_title = name_without_ext
    cutoff_patterns = [
        r'\b(19\d{2}|20[0-3]\d)\b',
        r'\b(1080p|720p|2160p|4k|bluray|web-dl|hdtv|s\d{2}e\d{2})\b'
    ]
    for pat in cutoff_patterns:
        m = re.search(pat, clean_title, re.I)
        if m:
            clean_title = clean_title[:m.start()]
            break

    clean_title = re.sub(r'[\._]', ' ', clean_title).strip()
    clean_title = re.sub(r'\s+', ' ', clean_title)
    if not clean_title:
        clean_title = name_without_ext.replace('.', ' ')

    folder_dir = os.path.dirname(rel_path)
    folder_name = folder_dir if folder_dir else "Root Directory"

    # Subtitles auto-detection
    dir_path = os.path.dirname(filepath)
    subtitles = []
    if os.path.isdir(dir_path):
        try:
            for f in os.listdir(dir_path):
                ext = os.path.splitext(f)[1].lower()
                if ext in ALLOWED_SUB_EXTENSIONS:
                    sub_rel = os.path.relpath(os.path.join(dir_path, f), MOVIES_ROOT)
                    subtitles.append({
                        "name": f,
                        "path": sub_rel.replace("\\", "/")
                    })
        except Exception:
            pass

    size_bytes = os.path.getsize(filepath) if os.path.exists(filepath) else 0
    mtime = os.path.getmtime(filepath) if os.path.exists(filepath) else 0
    added_str = datetime.fromtimestamp(mtime, timezone.utc).strftime("%Y-%m-%d %H:%M")

    rel_id = rel_path.replace("\\", "/")

    return {
        "id": rel_id,
        "filename": filename,
        "title": clean_title,
        "year": year,
        "quality": quality,
        "audio": audio,
        "codec": codec,
        "season_episode": season_episode,
        "category": category,
        "folder": folder_name,
        "filepath": filepath,
        "size": size_bytes,
        "size_formatted": format_size(size_bytes),
        "added": added_str,
        "subtitles": subtitles,
        "subtitle_url": f"/subtitle/{subtitles[0]['path']}" if subtitles else "",
        "poster_url": f"/poster/{rel_id}",
        "description": f"Located in {folder_name}. High definition media stream."
    }


def scan_movies_directory():
    videos = []
    folder_counts = {}

    if os.path.exists(MOVIES_ROOT):
        for root, dirs, files in os.walk(MOVIES_ROOT):
            dirs[:] = [d for d in dirs if d.lower() != "flask server" and not d.startswith(".")]

            for file in files:
                ext = os.path.splitext(file)[1].lower()
                if ext in ALLOWED_VIDEO_EXTENSIONS:
                    full_path = os.path.join(root, file)
                    rel_path = os.path.relpath(full_path, MOVIES_ROOT)
                    meta = parse_video_metadata(full_path, rel_path)
                    videos.append(meta)

                    f_name = meta["folder"]
                    folder_counts[f_name] = folder_counts.get(f_name, 0) + 1

    if os.path.exists(UPLOAD_FOLDER):
        for file in os.listdir(UPLOAD_FOLDER):
            if file in ("metadata.json", "cache"):
                continue
            ext = os.path.splitext(file)[1].lower()
            if ext in ALLOWED_VIDEO_EXTENSIONS:
                full_path = os.path.join(UPLOAD_FOLDER, file)
                rel_path = f"uploads/{file}"
                if not any(v["id"] == rel_path for v in videos):
                    meta = parse_video_metadata(full_path, rel_path)
                    meta["folder"] = "Uploads"
                    videos.append(meta)
                    folder_counts["Uploads"] = folder_counts.get("Uploads", 0) + 1

    videos.sort(key=lambda x: x["added"], reverse=True)

    folders_list = [
        {"name": k, "count": v} for k, v in sorted(folder_counts.items(), key=lambda item: item[0])
    ]

    with _lock:
        global _library, _folders
        _library = videos
        _folders = folders_list

    return len(videos)


def resolve_file_path(path_param):
    clean_param = unquote(path_param).replace("/", "\\")
    
    if clean_param.startswith("uploads\\"):
        full_path = os.path.abspath(os.path.join(APP_DIR, clean_param))
    else:
        full_path = os.path.abspath(os.path.join(MOVIES_ROOT, clean_param))

    if os.path.exists(full_path) and os.path.isfile(full_path):
        if full_path.startswith(MOVIES_ROOT) or full_path.startswith(UPLOAD_FOLDER):
            return full_path
    return None

# ---------------------------------------------------------------------------
# Flask Routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/videos")
def list_videos():
    q = (request.args.get("q") or "").strip().lower()
    folder_filter = (request.args.get("folder") or "").strip()

    with _lock:
        res = _library[:]

    if folder_filter:
        res = [v for v in res if v["folder"] == folder_filter]

    if q:
        res = [
            v for v in res
            if q in v["title"].lower() or q in v["filename"].lower() or q in v["folder"].lower()
        ]

    return jsonify(res)


@app.route("/api/folders")
def list_folders():
    with _lock:
        return jsonify(_folders)


@app.route("/api/video/<path:rel_path>/audio_tracks")
def get_video_audio_tracks(rel_path):
    full_path = resolve_file_path(rel_path)
    if not full_path:
        abort(404)
    tracks = get_audio_tracks(full_path)
    return jsonify(tracks)


@app.route("/api/scan", methods=["POST"])
def rescan():
    count = scan_movies_directory()
    return jsonify({"status": "success", "count": count})


@app.route("/upload", methods=["POST"])
def upload():
    if "video" not in request.files:
        return "No video file provided.", 400
    
    file = request.files["video"]
    if not file.filename:
        return "No file selected.", 400

    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in ALLOWED_VIDEO_EXTENSIONS:
        return "File extension not allowed.", 400

    os.makedirs(UPLOAD_FOLDER, exist_ok=True)
    save_path = os.path.join(UPLOAD_FOLDER, file.filename)
    file.save(save_path)

    scan_movies_directory()
    return jsonify({"status": "success", "filename": file.filename})


# ---------------------------------------------------------------------------
# Poster Image Endpoint (TMDB + FFmpeg Fallback Cache)
# ---------------------------------------------------------------------------

@app.route("/poster/<path:rel_path>")
def serve_poster(rel_path):
    full_path = resolve_file_path(rel_path)
    if not full_path:
        abort(404)

    # Find metadata record
    with _lock:
        rec = next((v for v in _library if v["id"] == rel_path), None)

    title = rec["title"] if rec else os.path.basename(full_path)
    category = rec["category"] if rec else "Movie"
    year = rec["year"] if rec else ""

    poster_file = get_or_create_poster(full_path, rel_path, title, category, year)
    if poster_file and os.path.exists(poster_file):
        return send_file(poster_file, mimetype="image/jpeg")
    
    abort(404)


# ---------------------------------------------------------------------------
# Range-Request Video Streaming & Multi-Audio Remuxing Endpoint
# ---------------------------------------------------------------------------

def get_mime_type(filepath):
    ext = os.path.splitext(filepath)[1].lower()
    mimes = {
        ".mp4": "video/mp4",
        ".mkv": "video/x-matroska",
        ".webm": "video/webm",
        ".avi": "video/x-msvideo",
        ".mov": "video/quicktime",
        ".m4v": "video/x-m4v",
        ".mp3": "audio/mpeg"
    }
    return mimes.get(ext, "video/mp4")


@app.route("/video/<path:rel_path>")
def stream_video(rel_path):
    full_path = resolve_file_path(rel_path)
    if not full_path:
        abort(404)

    audio_track_arg = request.args.get("audio", None)

    # If specific audio track requested via FFmpeg remuxing
    if audio_track_arg is not None:
        try:
            track_idx = int(audio_track_arg)
            tracks = get_audio_tracks(full_path)
            target_stream_idx = tracks[track_idx]["stream_index"] if (0 <= track_idx < len(tracks)) else 1
            
            # Start position if seeking
            ss_arg = []
            start_sec = request.args.get("t", None)
            if start_sec:
                try:
                    start_val = float(start_sec)
                    if start_val > 0:
                        ss_arg = ["-ss", str(start_val)]
                except ValueError:
                    pass

            cmd = [FFMPEG_BIN, "-y"]
            if ss_arg:
                cmd.extend(ss_arg)

            cmd.extend([
                "-i", full_path,
                "-map", "0:v:0",
                "-map", f"0:{target_stream_idx}",
                "-c:v", "copy",
                "-c:a", "aac",
                "-b:a", "192k",
                "-ac", "2",
                "-movflags", "frag_keyframe+empty_moov+default_base_moof",
                "-f", "mp4",
                "pipe:1"
            ])

            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

            def generate_ffmpeg_stream():
                try:
                    while True:
                        chunk = proc.stdout.read(1024 * 64)
                        if not chunk:
                            break
                        yield chunk
                finally:
                    if proc.poll() is None:
                        proc.kill()

            return Response(generate_ffmpeg_stream(), mimetype="video/mp4")
        except Exception as e:
            print("FFmpeg audio stream exception:", e)

    # Standard direct file range stream
    file_size = os.path.getsize(full_path)
    mime_type = get_mime_type(full_path)
    range_header = request.headers.get("Range", None)

    if not range_header:
        return send_file(full_path, mimetype=mime_type)

    try:
        bytes_match = re.search(r'bytes=(\d+)-(\d+)?', range_header)
        start = int(bytes_match.group(1))
        end = int(bytes_match.group(2)) if bytes_match.group(2) else file_size - 1
    except Exception:
        start = 0
        end = file_size - 1

    if start >= file_size:
        start = file_size - 1

    length = (end - start) + 1

    def generate_chunks():
        with open(full_path, "rb") as f:
            f.seek(start)
            remaining = length
            chunk_size = 1024 * 1024  # 1 MB
            while remaining > 0:
                read_size = min(chunk_size, remaining)
                data = f.read(read_size)
                if not data:
                    break
                remaining -= len(data)
                yield data

    response = Response(
        generate_chunks(),
        206,
        mimetype=mime_type,
        direct_passthrough=True
    )
    response.headers.add('Content-Range', f'bytes {start}-{end}/{file_size}')
    response.headers.add('Accept-Ranges', 'bytes')
    response.headers.add('Content-Length', str(length))
    return response


# ---------------------------------------------------------------------------
# Direct File Download Endpoint (Original Name Preserved)
# ---------------------------------------------------------------------------

@app.route("/download/<path:rel_path>")
def download_video(rel_path):
    full_path = resolve_file_path(rel_path)
    if not full_path:
        abort(404)

    # Retain exact original filename
    original_filename = os.path.basename(full_path)
    encoded_filename = quote(original_filename)

    resp = send_file(
        full_path,
        as_attachment=True,
        download_name=original_filename,
        mimetype=get_mime_type(full_path)
    )
    
    # Ensure Content-Disposition headers preserve original name strictly
    resp.headers["Content-Disposition"] = f'attachment; filename="{original_filename}"; filename*=UTF-8\'\'{encoded_filename}'
    return resp


# ---------------------------------------------------------------------------
# Subtitle Endpoint (SRT -> WebVTT)
# ---------------------------------------------------------------------------

@app.route("/subtitle/<path:rel_path>")
def serve_subtitle(rel_path):
    full_path = resolve_file_path(rel_path)
    if not full_path or not os.path.exists(full_path):
        abort(404)

    ext = os.path.splitext(full_path)[1].lower()

    if ext == ".vtt":
        return send_file(full_path, mimetype="text/vtt")
    elif ext == ".srt":
        try:
            with open(full_path, "r", encoding="utf-8", errors="ignore") as f:
                srt_content = f.read()
            
            vtt_content = "WEBVTT\n\n" + re.sub(
                r'(\d{2}:\d{2}:\d{2}),(\d{3})',
                r'\1.\2',
                srt_content
            )
            return Response(vtt_content, mimetype="text/vtt")
        except Exception as e:
            print("Subtitle conversion error:", e)
            abort(500)

    abort(404)


# ---------------------------------------------------------------------------
# Entry Point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    os.makedirs(UPLOAD_FOLDER, exist_ok=True)
    os.makedirs(POSTER_CACHE_DIR, exist_ok=True)

    print("\n" + "=" * 65)
    print("  FLOWFLIX — Local WiFi Netflix Streaming Server")
    print("=" * 65)
    
    print(f"\n  [+] Scanning '{MOVIES_ROOT}' for movies and videos...")
    count = scan_movies_directory()
    print(f"  [+] Discovered {count} media files.")

    print("\n  [+] Access FlowFlix in your browser:")
    print(f"      - Local PC:   http://localhost:{PORT}")
    for ip in get_local_ips():
        print(f"      - Mobile/WiFi: http://{ip}:{PORT}")
        qr = qrcode.QRCode(version=1, box_size=1, border=1)
        qr.add_data(f'http://{ip}:5000')
        qr.make(fit=True)
        qr.print_ascii()
    
    print("\n" + "=" * 65 + "\n")

    app.run(host=HOST, port=PORT, threaded=True)