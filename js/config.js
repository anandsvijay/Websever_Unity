import {getServers} from "./icesettings.js";

// Leave empty ("") for Render.com all-in-one hosting (HTML + WebSocket share the same URL).
export const DEFAULT_SIGNALING_URL = "";

export function getSignalingUrl() {
  const params = new URLSearchParams(window.location.search);
  const paramUrl = params.get('signaling') || params.get('ws') || DEFAULT_SIGNALING_URL;
  return paramUrl ? paramUrl.trim().replace(/\/+$/, '') : '';
}

export async function getServerConfig() {
  const customSignaling = getSignalingUrl();
  let baseHttpOrigin = location.origin;
  if (customSignaling) {
    baseHttpOrigin = customSignaling
      .replace(/^wss:\/\//i, 'https://')
      .replace(/^ws:\/\//i, 'http://');
  }
  const protocolEndPoint = baseHttpOrigin + '/config';
  try {
    const createResponse = await fetch(protocolEndPoint, { cache: 'no-store' });
    if (!createResponse.ok) {
      throw new Error(`HTTP ${createResponse.status}`);
    }
    const json = await createResponse.json();
    return { ...json, signalingUrl: customSignaling };
  } catch (_) {
    return {
      useWebSocket: true,
      startupMode: 'public',
      logging: 'dev',
      signalingUrl: customSignaling
    };
  }
}

export function getRTCConfiguration() {
  let config = {};
  config.sdpSemantics = 'unified-plan';
  config.iceServers = getServers();
  return config;
}
