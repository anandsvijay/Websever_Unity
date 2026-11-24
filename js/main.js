import { getServerConfig, getRTCConfiguration, getSignalingUrl } from "./config.js";
import { RenderStreaming } from "../module/renderstreaming.js";
import { Signaling, WebSocketSignaling } from "../module/signaling.js";
import { Sender, Observer } from "../module/sender.js";
import { InputRemoting } from "../module/inputremoting.js";

const videoElement = document.getElementById('videoFeed');
const videoFrame = document.getElementById('videoFrame');
const playOverlay = document.getElementById('playOverlay');
const orientationNotice = document.getElementById('orientationNotice');
const logContent = document.getElementById('logContent');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const toggleLogBtn = document.getElementById('toggleLogBtn');
const clearLogBtn = document.getElementById('clearLogBtn');
const logWindow = document.getElementById('logWindow');
const fitToggleBtn = document.getElementById('fitToggleBtn');

// Ensure video element attributes support browser autoplay policies
videoElement.setAttribute('playsinline', '');
videoElement.setAttribute('webkit-playsinline', '');
videoElement.setAttribute('muted', '');
videoElement.playsInline = true;
videoElement.muted = true;
videoElement.autoplay = true;

let renderstreaming = null;
let inputRemoting = null;
let sender = null;
let inputChannel = null;
let isFillMode = false;

function addLog(msg) {
  const line = document.createElement('div');
  const time = new Date().toLocaleTimeString();
  line.textContent = `[${time}] ${msg}`;
  logContent.appendChild(line);
  logContent.scrollTop = logContent.scrollHeight;
}

// Clear log button
clearLogBtn.addEventListener('click', () => {
  logContent.innerHTML = '';
});

// Toggle Log Window
toggleLogBtn.addEventListener('click', () => {
  logWindow.style.display = logWindow.style.display === 'none' ? 'flex' : 'none';
});

// Toggle Adaptable Frame Mode (Fit vs Fill)
fitToggleBtn.addEventListener('click', () => {
  isFillMode = !isFillMode;
  if (isFillMode) {
    videoFrame.classList.remove('fit-mode');
    videoFrame.classList.add('fill-mode');
    fitToggleBtn.textContent = 'Aspect: Fill';
    addLog('Frame adapted to: Fill (Edge-to-Edge).');
  } else {
    videoFrame.classList.remove('fill-mode');
    videoFrame.classList.add('fit-mode');
    fitToggleBtn.textContent = 'Aspect: Fit';
    addLog('Frame adapted to: Fit (Letterboxed).');
  }

  setTimeout(() => {
    if (sender) {
      sender._onResizeEvent();
    }
  }, 100);
});

// Fullscreen Toggle
fullscreenBtn.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen();
    } else if (document.documentElement.webkitRequestFullscreen) {
      document.documentElement.webkitRequestFullscreen();
    }
    fullscreenBtn.textContent = '⤓ Exit';
  } else {
    if (document.exitFullscreen) {
      document.exitFullscreen();
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    }
    fullscreenBtn.textContent = '⛶ Fullscreen';
  }
});

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) {
    fullscreenBtn.textContent = '⛶ Fullscreen';
  } else {
    fullscreenBtn.textContent = '⤓ Exit';
  }
  setTimeout(() => {
    if (sender) {
      sender._onResizeEvent();
    }
  }, 150);
});

// Mobile Orientation Check
function checkOrientation() {
  const isPortrait = window.innerHeight > window.innerWidth;
  if (isPortrait && window.innerWidth <= 768) {
    orientationNotice.classList.remove('hidden');
  } else {
    orientationNotice.classList.add('hidden');
  }
}

window.addEventListener('resize', () => {
  checkOrientation();
  if (sender) {
    sender._onResizeEvent();
  }
});

window.addEventListener('orientationchange', () => {
  setTimeout(() => {
    checkOrientation();
    if (sender) {
      sender._onResizeEvent();
    }
  }, 200);
});

checkOrientation();

// Video playback management
function hideOverlay() {
  playOverlay.classList.add('hidden');
}

function showOverlay() {
  playOverlay.classList.remove('hidden');
}

playOverlay.addEventListener('click', () => {
  attemptPlay();
});

function attemptPlay() {
  videoElement.play().then(() => {
    addLog('Video playback started.');
    hideOverlay();
  }).catch((err) => {
    addLog(`Autoplay waiting for touch: ${err.message}`);
    showOverlay();
  });
}

// User touch / click on stream ensures audio/video playback unlocks
function onUserInteraction() {
  if (videoElement.paused) {
    attemptPlay();
  }
}

window.addEventListener('touchstart', onUserInteraction, { passive: true });
window.addEventListener('click', onUserInteraction);

function updateVideoFrameAspect() {
  if (videoElement.videoWidth > 0 && videoElement.videoHeight > 0) {
    const ratio = videoElement.videoWidth / videoElement.videoHeight;
    videoFrame.style.setProperty('--stream-aspect', ratio.toFixed(4));
  }
  if (sender) {
    sender._onResizeEvent();
  }
}

videoElement.addEventListener('loadedmetadata', () => {
  attemptPlay();
  updateVideoFrameAspect();
  addLog(`Video feed started (${videoElement.videoWidth}x${videoElement.videoHeight}).`);
});

videoElement.addEventListener('resize', () => {
  updateVideoFrameAspect();
  addLog(`Video resolution active: ${videoElement.videoWidth}x${videoElement.videoHeight}`);
});

videoElement.addEventListener('playing', () => {
  hideOverlay();
  updateVideoFrameAspect();
  addLog(`Video playback active (${videoElement.videoWidth}x${videoElement.videoHeight}).`);
});

videoElement.addEventListener('pause', () => {
  if (!videoElement.ended) {
    showOverlay();
  }
});

// Prevent context menu to allow native click interactions
window.addEventListener('contextmenu', (e) => e.preventDefault());

// Coordinate synchronization and feedback
function handlePointerDown(e) {
  if (sender && sender._corrector && videoElement.videoWidth > 0) {
    if (sender._corrector._videoWidth !== videoElement.videoWidth || sender._corrector._videoHeight !== videoElement.videoHeight) {
      sender._onResizeEvent();
    }
  }
  const x = Math.round(e.clientX || (e.touches && e.touches[0] ? e.touches[0].clientX : 0));
  const y = Math.round(e.clientY || (e.touches && e.touches[0] ? e.touches[0].clientY : 0));
  addLog(`Input pointer down at (${x}, ${y})`);
}

videoElement.addEventListener('mousedown', handlePointerDown);
videoElement.addEventListener('touchstart', handlePointerDown, { passive: true });

async function start() {
  try {
    addLog('Fetching server configuration...');
    const serverConfig = await getServerConfig();
    const useWebSocket = serverConfig.useWebSocket;
    const customSignalingUrl = serverConfig.signalingUrl || getSignalingUrl();

    addLog(`Signaling mode: ${useWebSocket ? 'WebSocket' : 'HTTP'}`);
    const signaling = useWebSocket ? new WebSocketSignaling(1000, customSignalingUrl) : new Signaling();
    if (signaling.websocketUrl) {
      addLog(`Signaling Server URL: ${signaling.websocketUrl}`);
    }
    const rtcConfig = getRTCConfiguration();

    renderstreaming = new RenderStreaming(signaling, rtcConfig);

    // Diagnostics: ICE & Connection state changes
    renderstreaming.onIceConnectionStateChange = (state) => {
      addLog(`ICE state: ${state}`);
      if (state === 'failed') {
        addLog('ICE connection failed. Ensure PC firewall allows UDP ports or restart.');
      } else if (state === 'connected' || state === 'completed') {
        addLog('ICE connection established successfully!');
      }
    };

    renderstreaming.onConnectionStateChange = (state) => {
      addLog(`Peer connection: ${state}`);
    };

    renderstreaming.onIceGatheringStateChange = (state) => {
      addLog(`ICE gathering: ${state}`);
    };

    renderstreaming.onConnect = (connectionId) => {
      addLog(`Signaling session ready (id=${connectionId}). Waiting for Unity...`);
      // IMPORTANT: Do NOT add dummy recvonly transceivers here.
      // Unity's Broadcast component adds its VideoStreamSender track upon receiving
      // the dataChannel offer and sends a renegotiation offer back with the real track.
      setupInputChannel();
    };

    renderstreaming.onGotOffer = () => {
      addLog('Received stream Offer from Unity. Applying mobile codec preferences...');
      applyMobileCodecPreferences();
    };

    renderstreaming.onGotAnswer = () => {
      addLog('Connected to Unity! (Received SDP Answer from Unity)');
    };

    renderstreaming.onDisconnect = (connectionId) => {
      addLog(`Disconnected from Unity (${connectionId}). Reconnecting in 3s...`);
      cleanup();
      setTimeout(start, 3000);
    };

    renderstreaming.onTrackEvent = (data) => {
      const track = data.track;
      if (!track) return;
      addLog(`Received remote ${track.kind} track (id=${track.id}).`);

      if (!videoElement.srcObject) {
        videoElement.srcObject = new MediaStream();
      }

      // Remove any previous track of the same kind so <video> always displays the active Unity stream
      const oldTracks = videoElement.srcObject.getTracks().filter(t => t.kind === track.kind && t.id !== track.id);
      oldTracks.forEach(t => videoElement.srcObject.removeTrack(t));

      if (!videoElement.srcObject.getTracks().some(t => t.id === track.id)) {
        videoElement.srcObject.addTrack(track);
      }

      track.onunmute = () => {
        addLog(`Remote ${track.kind} track unmuted (media packets flowing).`);
        attemptPlay();
      };

      attemptPlay();
      if (track.kind === 'video') {
        startVideoStatsCheck();
      }
    };

    addLog('Starting signaling connection...');
    await renderstreaming.start();
    await renderstreaming.createConnection();
    addLog('Connection initialized. Waiting for Unity...');
  } catch (err) {
    addLog(`Error: ${err.message}`);
    setTimeout(start, 4000);
  }
}

function applyMobileCodecPreferences() {
  if (!renderstreaming) return;
  try {
    const getCaps = (window.RTCRtpReceiver && typeof RTCRtpReceiver.getCapabilities === 'function')
      ? RTCRtpReceiver.getCapabilities('video')
      : (window.RTCRtpSender && typeof RTCRtpSender.getCapabilities === 'function' ? RTCRtpSender.getCapabilities('video') : null);

    if (!getCaps || !getCaps.codecs) return;

    const vp8Codecs = getCaps.codecs.filter(c => c.mimeType.toLowerCase() === 'video/vp8');
    const h264Baseline = getCaps.codecs.filter(c =>
      c.mimeType.toLowerCase() === 'video/h264' &&
      c.sdpFmtpLine &&
      c.sdpFmtpLine.includes('42e01f')
    );
    const restCodecs = getCaps.codecs.filter(c => !vp8Codecs.includes(c) && !h264Baseline.includes(c));
    const orderedCodecs = [...vp8Codecs, ...h264Baseline, ...restCodecs];

    const transceivers = renderstreaming.getTransceivers().filter(
      t => t.receiver && t.receiver.track && t.receiver.track.kind === 'video'
    );

    if (transceivers && transceivers.length > 0 && orderedCodecs.length > 0) {
      transceivers.forEach(t => {
        if (typeof t.setCodecPreferences === 'function') {
          t.setCodecPreferences(orderedCodecs);
        }
      });
      addLog('Mobile codec preference applied (VP8 / H264 Baseline).');
    }
  } catch (err) {
    addLog(`Codec preference note: ${err.message}`);
  }
}

let statsTimer = null;
function startVideoStatsCheck() {
  if (statsTimer) clearInterval(statsTimer);
  let checks = 0;
  let loggedFirstFrame = false;

  statsTimer = setInterval(async () => {
    checks++;
    if (!renderstreaming || checks > 15) {
      clearInterval(statsTimer);
      statsTimer = null;
      return;
    }
    try {
      const stats = await renderstreaming.getStats();
      if (!stats) return;
      stats.forEach(report => {
        if (report.type === 'inbound-rtp' && report.kind === 'video') {
          const bytes = report.bytesReceived || 0;
          const frames = report.framesDecoded || 0;
          if (frames > 0 && !loggedFirstFrame) {
            loggedFirstFrame = true;
            addLog(`Stream active: ${frames} frames decoded (${Math.round(bytes / 1024)} KB received).`);
            attemptPlay();
            clearInterval(statsTimer);
            statsTimer = null;
          } else if (checks === 5 && frames === 0) {
            addLog(`Waiting for video frames (bytesReceived=${bytes})... Ensure Unity Editor is playing.`);
          }
        }
      });
    } catch (_) {}
  }, 1000);
}

function setupInputChannel() {
  if (!renderstreaming) return;

  try {
    inputChannel = renderstreaming.createDataChannel('input');

    sender = new Sender(videoElement);
    sender.addMouse();
    sender.addKeyboard();

    if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
      sender.addTouchscreen();
    }
    sender.addGamepad();

    inputRemoting = new InputRemoting(sender);
    const observer = new Observer(inputChannel);
    inputRemoting.subscribe(observer);

    const onChannelOpen = async () => {
      await new Promise((r) => setTimeout(r, 100));

      if (sender && videoElement.videoWidth > 0) {
        sender._onResizeEvent();
      }

      inputRemoting.startSending();
      addLog(`Input remoting active (ready to send clicks & keys).`);
    };

    if (inputChannel.readyState === 'open') {
      onChannelOpen();
    } else {
      inputChannel.onopen = onChannelOpen;
    }

    inputChannel.onclose = () => {
      addLog('Input channel closed.');
      if (inputRemoting) {
        inputRemoting.stopSending();
      }
    };

    inputChannel.onerror = (e) => {
      addLog(`Input channel error: ${e.message || 'unknown'}`);
    };
  } catch (err) {
    addLog(`Failed to setup input: ${err.message}`);
  }
}

function cleanup() {
  if (statsTimer) {
    clearInterval(statsTimer);
    statsTimer = null;
  }
  if (inputRemoting) {
    inputRemoting.stopSending();
    inputRemoting = null;
  }
  if (inputChannel) {
    try {
      inputChannel.close();
    } catch (_) {}
    inputChannel = null;
  }
  sender = null;
  if (videoElement.srcObject) {
    try {
      videoElement.srcObject.getTracks().forEach((track) => track.stop());
    } catch (_) {}
    videoElement.srcObject = null;
  }
  showOverlay();
}

window.addEventListener('beforeunload', async () => {
  cleanup();
  if (renderstreaming) {
    await renderstreaming.stop();
  }
});

// Start connection
start();
