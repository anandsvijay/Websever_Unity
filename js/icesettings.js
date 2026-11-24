// ICE (STUN + Free TURN Relay) configuration for cross-network & mobile streaming

const servers = document.querySelector('select#servers');
const urlInput = document.querySelector('input#url');
const usernameInput = document.querySelector('input#username');
const passwordInput = document.querySelector('input#password');

const allServersKey = 'servers_v2';

const DEFAULT_ICE_SERVERS = [
  {
    urls: [
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
      'stun:stun.cloudflare.com:3478',
      'stun:openrelay.metered.ca:80'
    ]
  },
  {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
      'turn:openrelay.metered.ca:443?transport=tcp'
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject'
  }
];

export function addServer() {
  if (!urlInput) return;
  const scheme = urlInput.value.split(':')[0];
  if (!['stun', 'stuns', 'turn', 'turns'].includes(scheme)) {
    alert(`URI scheme ${scheme} is not valid`);
    return;
  }

  const option = document.createElement('option');
  const iceServer = {
    urls: [urlInput.value],
    username: usernameInput.value,
    credential: passwordInput.value
  };
  option.value = JSON.stringify(iceServer);
  option.text = `${urlInput.value} `;
  const username = usernameInput.value;
  const password = passwordInput.value;
  if (username || password) {
    option.text += (` [${username}:${password}]`);
  }
  option.ondblclick = selectServer;
  if (servers) servers.add(option);
  urlInput.value = usernameInput.value = passwordInput.value = '';
  writeServersToLocalStorage();
}

export function removeServer() {
  if (!servers) return;
  for (let i = servers.options.length - 1; i >= 0; --i) {
    if (servers.options[i].selected) {
      servers.remove(i);
    }
  }
  writeServersToLocalStorage();
}

export function reset() {
  window.localStorage.clear();
  const serversSelect = document.querySelector('select#servers');
  if (serversSelect) {
    document.querySelectorAll('select#servers option').forEach(option => option.remove());
    setDefaultServer(serversSelect);
  }
}

function selectServer(event) {
  const option = event.target;
  const value = JSON.parse(option.value);
  if (urlInput) urlInput.value = value.urls[0];
  if (usernameInput) usernameInput.value = value.username || '';
  if (passwordInput) passwordInput.value = value.credential || '';
}

function setDefaultServer(serversSelect) {
  for (const server of DEFAULT_ICE_SERVERS) {
    const option = document.createElement('option');
    option.value = JSON.stringify(server);
    option.text = server.urls.join(', ');
    option.ondblclick = selectServer;
    serversSelect.add(option);
  }
}

function writeServersToLocalStorage() {
  const serversSelect = document.querySelector('select#servers');
  if (!serversSelect) return;
  const allServers = JSON.stringify(Object.values(serversSelect.options).map(o => JSON.parse(o.value)));
  window.localStorage.setItem(allServersKey, allServers);
}

export function readServersFromLocalStorage() {
  const serversSelect = document.querySelector('select#servers');
  if (!serversSelect) return;
  document.querySelectorAll('select#servers option').forEach(option => option.remove());
  const storedServers = window.localStorage.getItem(allServersKey);

  if (storedServers === null || storedServers === '') {
    setDefaultServer(serversSelect);
  } else {
    JSON.parse(storedServers).forEach((server) => {
      const o = document.createElement('option');
      o.value = JSON.stringify(server);
      o.text = server.urls[0];
      o.ondblclick = selectServer;
      serversSelect.add(o);
    });
  }
}

export function getServers() {
  const storedServers = window.localStorage.getItem(allServersKey);

  if (storedServers === null || storedServers === '') {
    return DEFAULT_ICE_SERVERS;
  } else {
    try {
      return JSON.parse(storedServers);
    } catch (_) {
      return DEFAULT_ICE_SERVERS;
    }
  }
}
