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
let isUnityConnected = false;
let hasReceivedVideoTrack = false;
let waitingLogShown = false;
let handshakeRetryTimer = null;
let reconnectTimer = null;

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
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  try {
    if (!waitingLogShown) {
      addLog('Connecting to signaling server...');
    }
    const serverConfig = await getServerConfig();
    const useWebSocket = serverConfig.useWebSocket;
    const customSignalingUrl = serverConfig.signalingUrl || getSignalingUrl();

    const signaling = useWebSocket ? new WebSocketSignaling(1000, customSignalingUrl) : new Signaling();
    if (!waitingLogShown && signaling.websocketUrl) {
      addLog(`Signaling Server: ${signaling.websocketUrl}`);
    }
    const rtcConfig = getRTCConfiguration();

    renderstreaming = new RenderStreaming(signaling, rtcConfig);

    // Diagnostics: ICE & Connection state changes
    renderstreaming.onIceConnectionStateChange = (state) => {
      if (isUnityConnected) {
        addLog(`ICE state: ${state}`);
      }
      if (state === 'failed' || state === 'disconnected' || state === 'closed') {
        if (isUnityConnected) {
          addLog('Unity stream disconnected. Waiting for Unity to start again...');
        }
        handleUnityDisconnect();
      } else if (state === 'connected' || state === 'completed') {
        addLog('ICE media connection established!');
      }
    };

    renderstreaming.onConnectionStateChange = (state) => {
      if (isUnityConnected) {
        addLog(`Peer connection: ${state}`);
      }
      if (state === 'failed' || state === 'disconnected' || state === 'closed') {
        handleUnityDisconnect();
      }
    };

    renderstreaming.onIceGatheringStateChange = () => {};

    renderstreaming.onConnect = () => {
      // NOTE: onConnect only means the signaling server registered our session ID.
      // Do NOT log "Connected to Unity" yet — Unity might not be open yet!
      if (!waitingLogShown) {
        addLog('Signaling ready. Waiting for Unity Editor / App to start...');
        waitingLogShown = true;
      }
      setupInputChannel();
      scheduleHandshakeRetry();
    };

    renderstreaming.onGotAnswer = (connectionId) => {
      clearHandshakeRetry();
      if (!isUnityConnected) {
        isUnityConnected = true;
        waitingLogShown = false;
        addLog(`Connected to Unity! (connectionId=${connectionId})`);
      }
    };

    renderstreaming.onGotOffer = (connectionId) => {
      clearHandshakeRetry();
      if (!isUnityConnected) {
        isUnityConnected = true;
        waitingLogShown = false;
        addLog(`Connected to Unity! (connectionId=${connectionId})`);
      }
      addLog('Received video stream Offer from Unity.');
    };

    renderstreaming.onDisconnect = () => {
      if (isUnityConnected) {
        addLog('Unity Editor / App stopped. Waiting for Unity to start again...');
      }
      handleUnityDisconnect();
    };

    renderstreaming.onTrackEvent = (data) => {
      const track = data.track;
      if (!track) return;

      clearHandshakeRetry();
      if (!isUnityConnected) {
        isUnityConnected = true;
        waitingLogShown = false;
        addLog('Connected to Unity!');
      }
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
        if (track.kind === 'video' || (videoElement.srcObject && videoElement.srcObject.getVideoTracks().length > 0)) {
          attemptPlay();
        }
      };

      if (track.kind === 'video') {
        hasReceivedVideoTrack = true;
        // Re-assign srcObject when video track is added after audio track so <video> attaches the video decoder
        const currentStream = videoElement.srcObject;
        videoElement.srcObject = currentStream;
        attemptPlay();
        startVideoStatsCheck();
      }
    };

    await renderstreaming.start();
    await renderstreaming.createConnection();
  } catch (err) {
    addLog(`Connection retry: ${err.message}`);
    scheduleReconnect(4000);
  }
}

function clearHandshakeRetry() {
  if (handshakeRetryTimer) {
    clearTimeout(handshakeRetryTimer);
    handshakeRetryTimer = null;
  }
}

function scheduleHandshakeRetry() {
  clearHandshakeRetry();
  handshakeRetryTimer = setTimeout(async () => {
    if (hasReceivedVideoTrack) return;

    // Unity hasn't sent a video track yet (either Unity isn't open yet, or the initial offer was missed).
    // Quietly rotate to a fresh connectionId offer so the browser connects automatically without manual refresh!
    try {
      if (inputRemoting) {
        inputRemoting.stopSending();
        inputRemoting = null;
      }
      if (inputChannel) {
        try { inputChannel.close(); } catch (_) {}
        inputChannel = null;
      }
      sender = null;
      isUnityConnected = false;

      if (renderstreaming) {
        await renderstreaming.createConnection();
      } else {
        scheduleReconnect(2000);
      }
    } catch (_) {
      scheduleReconnect(3000);
    }
  }, 4500);
}

function handleUnityDisconnect() {
  clearHandshakeRetry();
  const wasConnected = isUnityConnected;
  isUnityConnected = false;
  hasReceivedVideoTrack = false;
  if (wasConnected) {
    waitingLogShown = false;
  }
  cleanup();
  scheduleReconnect(2500);
}

function scheduleReconnect(delayMs) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (renderstreaming) {
      try { await renderstreaming.stop(); } catch (_) {}
      renderstreaming = null;
    }
    start();
  }, delayMs);
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
      if (inputRemoting) {
        inputRemoting.stopSending();
      }
      if (isUnityConnected) {
        addLog('Unity input channel closed. Waiting for Unity to start again...');
        handleUnityDisconnect();
      }
    };

    inputChannel.onerror = (e) => {
      if (isUnityConnected) {
        addLog(`Input channel error: ${e.message || 'unknown'}`);
      }
    };
  } catch (err) {
    addLog(`Failed to setup input: ${err.message}`);
  }
}

function cleanup() {
  clearHandshakeRetry();
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
