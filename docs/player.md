# 📺 Player reference — HLS.js Advanced Latency Monitor

The monitoring player served at `/player` (source: `app/player/hls-id3-player.html`).
It is a single self-contained HTML file, so it also works standalone:
`open app/player/hls-id3-player.html`, or serve it with `python -m http.server`.

Pass `?src=<url>` to load a stream on open — the harness dashboard uses this
to hand the player a freshly signed playback URL.

## ✨ Features

### Core Monitoring
- **Real-time Latency Tracking** - Monitor stream latency with wall-clock timestamps from ID3 metadata
- **Live Edge Drift Detection** - Track and visualize drift from the live edge with auto-sync capabilities
- **Performance Metrics** - Buffer levels, dropped frames, rebuffer counts, segment load times
- **HTTP Status Monitoring** - Track all network requests with detailed success/error rates

### Advanced Features
- **ID3 Metadata Parser** - Parse and display all ID3 frames including SCTE-35 markers
- **DRM/Encryption Monitor** - Support for Widevine, PlayReady, FairPlay with key rotation tracking
- **CMAF Detection** - Automatic detection of CMAF, fMP4, and MPEG-TS formats
- **ABR Bandwidth Monitor** - Track bandwidth estimates and quality switching decisions
- **Audio Track Monitor** - Multi-audio track support with real-time level monitoring via Web Audio API
- **Caption/Subtitle Monitor** - WebVTT and CEA-608/708 caption tracking and history
- **Program Date Time** - Compare PDT-based latency with ID3-based measurements
- **Manifest Viewer** - Raw and parsed views of master and media playlists

### User Experience
- **HLS.js Version Selector** - Switch between HLS.js versions (1.6.14-1.6.16) with hot reload
- **Tab Visibility Warnings** - Detect and warn about drift when tab is hidden
- **Auto-Jump to Live** - Configurable auto-sync when drift exceeds threshold
- **Preset URLs** - Quick access to Uplynk and public test streams
- **Responsive Design** - Works on desktop and mobile browsers

## ⚠️ Important: Uplynk Slicer Configuration

### Required Setting for Latency Monitoring

For latency monitoring to work with Uplynk streams, your slicer **MUST** have this setting enabled:
```yaml
wallclock: 1
```

**What this does:**
- Injects wall-clock timestamps into ID3 metadata
- Enables real-time latency calculation
- Required for all latency metrics to function

**Without this setting:**
- ⚠️ You'll see: "No wall-clock timestamps detected in ID3 metadata"
- ⚠️ Latency metrics will show: "--"
- ⚠️ Latency graph will remain empty

**To verify it's working:**
1. Load your stream
2. Look for: "✅ Wall-clock timestamps detected! Latency monitoring active."
3. Latency metrics should populate within a few seconds

**Need help configuring your slicer?** See the [Uplynk documentation](https://docs.uplynk.com) or contact Uplynk support.

## ⚙️ Prerequisites

### For Uplynk Streams

**CRITICAL:** Your Uplynk slicer **must** have `wallclock: 1` enabled in its configuration.

**How to enable:**
1. Access your Uplynk slicer configuration
2. Set `wallclock: 1` in the slicer settings
3. Restart the slicer
4. Verify timestamps appear in the stream

For help configuring your slicer, see the [Uplynk documentation](https://docs.uplynk.com) or contact Uplynk support.

### For Non-Uplynk Streams

Your encoder must include one of the following in ID3 metadata:
- `#EXT-X-DATERANGE` with `START-DATE` attribute
- TXXX frames with "wallclock", "timestamp", or "time" descriptions
- Program Date Time (`#EXT-X-PROGRAM-DATE-TIME`)

## 📊 Dashboard Sections

### Latency Metrics
- **Current Latency** - Real-time latency with color-coded status (Awesome/Good/Average/Above Average/Yuk)
- **Average/Min/Max** - Historical statistics across all samples
- **Latency Graph** - 60-second rolling history with threshold zones
- **Jump to Live** - Manual or auto-sync when drift is high

### Performance Metrics
- **Buffer Level** - Current buffer with visual indicator
- **Download Speed** - Measured from actual segment downloads
- **Quality/Bitrate** - Current video quality and bitrate
- **Dropped Frames** - Frame drop count and percentage
- **Rebuffers** - Count and total time spent rebuffering
- **Segment Load Time** - Average load time for media segments

### ID3 Metadata
- **Frame Parser** - Displays all ID3 frames (PRIV, TXXX, etc.)
- **SCTE-35 Detection** - Highlights ad markers with hex dumps
- **Timestamp Tracking** - Shows wall-clock timestamps for latency calculation
- **History Log** - Last 50 metadata entries with timestamps

### DRM/Encryption Monitor
- **Encryption Detection** - Automatic detection of AES-128, SAMPLE-AES, CBCS, CENC
- **Key Tracking** - Monitors all loaded keys with unique key identification
- **Key Rotation** - Detects and counts key rotations with notifications
- **Session Monitoring** - Tracks EME sessions and DRM system info
- **Key History** - Detailed log with hover tooltips showing full key details

### CMAF/Format Detection
- **Container Format** - Detects fMP4, MPEG-TS, or CMAF
- **Init Segments** - Counts and tracks initialization segments
- **Byte Range Mode** - Detects byte-range requests
- **Codec Detection** - Shows video and audio codecs

### Live Edge Drift Monitor
- **Visual Gauge** - Color-coded drift indicator (0-50+ seconds)
- **Drift Stats** - Current drift, buffer, playback rate, status
- **Auto-Sync** - Configurable threshold for automatic jump to live
- **History Graph** - 60-second rolling drift history
- **Tab Return Auto-Jump** - Optional auto-jump when returning to tab

### ABR Bandwidth Monitor
- **Bandwidth Estimate** - Current bandwidth with trend indicator
- **Throughput** - Estimated throughput from segment downloads
- **Quality Switches** - Count and log of all quality changes
- **Bandwidth Graph** - 60-second rolling bandwidth history
- **Decision Log** - Recent ABR decisions with reasons

### Audio Track Monitor
- **Multi-Track Support** - Switch between multiple audio tracks
- **Codec Detection** - Shows audio codec and bitrate
- **Real-Time Level** - Visual audio level meter using Web Audio API
- **Track Selector** - Click to switch audio tracks

### Caption/Subtitle Monitor
- **Live Display** - Shows current caption text in real-time
- **Track Selector** - Enable/disable caption tracks
- **Caption History** - Last 50 captions with timestamps
- **Format Detection** - WebVTT, CEA-608/708

### Manifest Viewer
- **Master Manifest** - Parsed variant streams with color coding
- **Media Playlist** - Current playlist with discontinuity tracking
- **Raw View** - Syntax-highlighted raw manifest
- **Discontinuity Log** - Tracks all discontinuities with context

### HTTP Status Monitor
- **Success/Redirect/Error Counts** - Categorized by status code
- **Success Rate** - Percentage of successful requests
- **Request Log** - Last 20 requests with URLs (hover for full URL)

### Program Date Time
- **PDT Latency** - Latency calculated from EXT-X-PROGRAM-DATE-TIME
- **ID3 Comparison** - Delta between PDT and ID3 latencies
- **Timestamp Display** - Shows program time vs system time

## 🎯 Preset Streams

### Uplynk Streams
- **Event Base URL** - Pre-event testing (requires Event GUID)

### Encrypted Test Streams (AES-128)
- **Apple Bipbop fMP4** - Apple's test stream with encryption
- **Apple Bipbop HEVC** - HEVC encoded with encryption
- **Bitmovin Art of Motion** - DRM test stream

### Public Test Streams (Clear)
- **Mux Big Buck Bunny** - Popular test stream
- **Tears of Steel (4K)** - High-quality 4K test stream

## 🔧 Configuration

### HLS.js Version Selection
- Click the version dropdown in the banner
- Select your desired version (1.6.14-1.6.16)
- Page will prompt for reload to apply new version
- Selection persists across sessions

### DRM Configuration
1. Select a license server from the dropdown:
   - **Widevine** - `https://content.uplynk.com/wv`
   - **PlayReady** - `https://content.uplynk.com/pr`
   - **Custom URL** - Enter your own license server

2. For custom URLs:
   - Select "Custom URL" from dropdown
   - Enter full HTTPS URL
   - Click "Apply"
   - Load your stream

### Debug Mode
- Toggle "Debug Mode" in the DRM panel
- Enables verbose console logging for:
  - DRM key operations
  - Bandwidth calculations
  - Performance metrics
  - All HLS.js events

### Auto-Sync Configuration
- Enable "Auto-sync" checkbox in Drift Monitor
- Set threshold (10-120 seconds)
- Stream auto-jumps to live when drift exceeds threshold
- Optional: Enable "Auto-jump on return to tab"

## 🛠️ Technical Details

### Requirements
- Modern browser with:
  - HLS.js support (or native HLS on Safari)
  - ES6+ JavaScript support
  - Web Audio API (optional, for audio levels)
  - Encrypted Media Extensions (optional, for DRM)

### Browser Compatibility
- ✅ Chrome/Edge 90+
- ✅ Firefox 88+
- ✅ Safari 14+
- ✅ Mobile browsers (iOS Safari, Chrome Android)

### Performance Optimizations
- **Throttled Updates** - UI updates throttled to 30-60fps
- **DOM Caching** - Frequently accessed elements cached
- **Batch Updates** - Multiple DOM updates batched together
- **RequestAnimationFrame** - Smooth graph animations
- **Web Workers** - HLS.js uses workers when available

### ID3 Timestamp Requirements

**For Uplynk Streams:**

Your Uplynk slicer **must** have `wallclock: 1` enabled to inject wall-clock timestamps into ID3 metadata. This is **required** for accurate latency monitoring.

**Slicer Configuration:**
```yaml
# Uplynk Slicer Configuration
wallclock: 1  # REQUIRED for latency monitoring
```

**What happens when enabled:**
- Wall-clock timestamps injected into ID3 TXXX frames
- Timestamps include millisecond precision
- Format: ISO 8601 (e.g., `2024-12-16T12:34:56.789Z`)

**For Other Platforms:**

Your stream must include wall-clock timestamps in one of these formats:
```
# Option 1: EXT-X-DATERANGE (Recommended)
#EXT-X-DATERANGE:ID="...",START-DATE="2024-12-16T12:00:00.000Z"

# Option 2: ID3 TXXX frames
TXXX frame with description "wallclock", "timestamp", or "time"
ISO 8601 formatted timestamp value

# Option 3: Program Date Time
#EXT-X-PROGRAM-DATE-TIME:2024-12-16T12:00:00.000Z
```

## 📈 Interpreting Metrics

### Latency Classifications
- **🟢 Awesome** - <10 seconds (dark green)
- **🟢 Good** - 10-19 seconds (green)
- **🟡 Average** - 19-25 seconds (light orange)
- **🟠 Above Average** - 25-40 seconds (orange)
- **🔴 Yuk** - 40+ seconds (red, pulsing)

### Drift Status
- **Good** - <10 seconds behind live
- **Fair** - 10-20 seconds behind
- **Behind** - 20-30 seconds behind
- **Far** - 30-50 seconds behind
- **Critical** - 50+ seconds behind

### Buffer Levels
- **🟢 Good** - >10 seconds
- **🟡 Warning** - 5-10 seconds
- **🔴 Critical** - <5 seconds

## 🐛 Troubleshooting

### No Latency Data

**For Uplynk Streams:**
1. ✅ **Verify `wallclock: 1` is enabled** in your slicer configuration
2. ✅ Restart the slicer after making configuration changes
3. ✅ Check that the stream is actively encoding (not a static VOD file)
4. ✅ Enable debug mode and check console for ID3 metadata
5. ✅ Look for the success message: "✅ Wall-clock timestamps detected!"

**Debug Steps:**
```bash
# Check console for these messages:
# ✅ Good: "Successfully parsed wallclock: ..."
# ❌ Bad: "No wall-clock timestamps detected"

# Enable debug mode to see all ID3 frames
# Look for TXXX frames with wallclock data
```

**For All Streams:**
- Ensure stream includes ID3 metadata with timestamps
- Check that TXXX frames contain wall-clock data
- Enable debug mode to see metadata in console
- Verify encoder is configured to inject timestamps

**Common Issues:**
- ❌ `wallclock: 0` or not set → No timestamps will be injected
- ❌ VOD file without ID3 → Timestamps may not be present in static files
- ❌ Manifest-only latency → Use Program Date Time instead
- ❌ Incorrect timestamp format → Must be ISO 8601

**Still not working?**
Open a [GitHub issue](https://github.com/jj358mhz/player_test_harness/issues) with:
- Stream URL (if shareable)
- Slicer configuration (especially wallclock setting)
- Browser console output with debug mode enabled
- Screenshot of the latency panel

### DRM Not Working
- Check license server URL is correct
- Verify DRM system matches your stream (Widevine/PlayReady/FairPlay)
- Check browser console for EME errors
- Ensure HTTPS (DRM requires secure context)

### High Latency
- Check your encoder's target latency settings
- Verify segment duration (shorter = lower latency)
- Check network conditions
- Use "Jump to Live" button to sync
- Consider reducing `wallclock` reporting frequency if very high

### Tab Visibility Issues
- Enable "Auto-jump on return to tab" in Drift Monitor
- Browsers throttle hidden tabs - this is expected behavior
- Keep tab visible for accurate monitoring
