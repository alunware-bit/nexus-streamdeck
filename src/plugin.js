// Copyright (c) 2026 Alun Ware. All rights reserved.
// Nexus Stream Deck Plugin — main entry point.
// Communicates with Stream Deck software via WebSocket on argv[3].

const WebSocket = require('ws');

const NEXUS_BASE = 'https://web-production-bec6d.up.railway.app';
const POLL_INTERVAL_MS = 5000;

// ── Helpers ──────────────────────────────────────────────────────────────────

async function nexusFetch(path, apiKey, opts = {}) {
  const res = await fetch(NEXUS_BASE + path, {
    ...opts,
    headers: { 'x-nexus-api-key': apiKey, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

function drawCanvas(size, drawFn) {
  // Returns a base64 PNG drawn via a minimal canvas impl.
  // Stream Deck accepts base64 PNG for dynamic key images.
  // We build a tiny SVG and encode it as a data URI since we have no DOM.
  return drawFn(size);
}

function svgToBase64(svg) {
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

function scoreColor(grade) {
  return { A: '#4ade80', B: '#a3e635', C: '#facc15', D: '#fb923c', F: '#f87171' }[grade] || '#888';
}

function calcStreamScore(data) {
  let score = 100;
  if (data.viewerTrend < 0) score -= 20;
  if (data.chatRate < 2) score -= 15;
  if (data.uptime < 10) score -= 10;
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 45) return 'D';
  return 'F';
}

// ── Plugin core ───────────────────────────────────────────────────────────────

class NexusPlugin {
  constructor() {
    this.ws = null;
    this.contexts = new Map(); // context → { action, settings }
    this.pollTimer = null;
    this.streamData = {};     // cached stream data per apiKey
    this.raidTarget = null;   // pending incoming raid username
    this.raidTargetId = null; // pending incoming raid DB id (for consume)
    this.sessionPeaks = {};   // context → peak viewer count this session
    this.globalApiKey = null; // shared API key across all actions
    this.profileImageCache = new Map(); // username → base64 data URI
  }

  connect(port, pluginUUID) {
    this.pluginUUID = pluginUUID;
    this.ws = new WebSocket('ws://127.0.0.1:' + port);
    this.ws.on('open', () => {
      this.send({ event: 'registerPlugin', uuid: pluginUUID });
      this.send({ event: 'getGlobalSettings', context: pluginUUID });
      this.startPolling();
    });
    this.ws.on('message', (raw) => this.handleMessage(JSON.parse(raw.toString())));
    this.ws.on('close', () => { clearInterval(this.pollTimer); });
  }

  send(payload) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  setTitle(context, title) {
    this.send({ event: 'setTitle', context, payload: { title, target: 0 } });
  }

  setImage(context, base64) {
    this.send({ event: 'setImage', context, payload: { image: base64, target: 0 } });
  }

  setState(context, state) {
    this.send({ event: 'setState', context, payload: { state } });
  }

  showOk(context) { this.send({ event: 'showOk', context }); }
  showAlert(context) { this.send({ event: 'showAlert', context }); }

  handleMessage(msg) {
    const { event, context, action, payload } = msg;

    if (event === 'didReceiveGlobalSettings') {
      this.globalApiKey = payload?.settings?.apiKey || this.globalApiKey || null;
    }
    if (event === 'sendToPlugin') {
      if (payload?.type === 'apiKey' && payload?.apiKey) {
        this.globalApiKey = payload.apiKey;
        // Persist to every action's settings so it survives plugin restarts
        for (const [ctx, info] of this.contexts) {
          info.settings.apiKey = payload.apiKey;
          this.send({ event: 'setSettings', context: ctx, payload: info.settings });
        }
      }
    }
    if (event === 'willAppear') {
      const s = payload?.settings || {};
      this.contexts.set(context, { action, settings: s });
      setTimeout(() => this.refreshContext(context), 500);
    }
    if (event === 'willDisappear') this.contexts.delete(context);
    if (event === 'didReceiveSettings') {
      const ctx = this.contexts.get(context);
      if (ctx) ctx.settings = payload?.settings || {};
    }
    if (event === 'keyDown') this.handlePress(context, action, payload?.settings || {});
  }

  async handlePress(context, action, settings) {
    const key = this.globalApiKey || settings.apiKey;
    if (!key) {
      this.showAlert(context);
      return;
    }

    try {
      switch (action) {

        case 'com.nexus.streamdeck.clip':
        case 'com.nexus.streamdeck.clip-reel': {
          this.setState(context, 1);
          const data = await nexusFetch('/api/streamdeck/clip', key, { method: 'POST' });
          if (data.success) {
            this.showOk(context);
            if (action === 'com.nexus.streamdeck.clip-reel' && data.url) {
              await nexusFetch('/api/streamdeck/team-message', key, {
                method: 'POST',
                body: JSON.stringify({ message: '✂ Auto-clipped! ' + data.url }),
              });
            }
          } else {
            this.showAlert(context);
          }
          setTimeout(() => this.setState(context, 0), 2000);
          break;
        }

        case 'com.nexus.streamdeck.marker': {
          const data = await nexusFetch('/api/streamdeck/marker', key, { method: 'POST', body: JSON.stringify({ description: 'Stream Deck marker' }) });
          data.success ? this.showOk(context) : this.showAlert(context);
          break;
        }

        case 'com.nexus.streamdeck.raid-radar': {
          const sd = this.streamData[key];
          if (sd?.liveTeam?.length) {
            const target = sd.liveTeam[sd.radarDisplay ?? 0];
            await nexusFetch('/api/streamdeck/raid-execute', key, { method: 'POST', body: JSON.stringify({ toUsername: target.username }) });
            this.showOk(context);
          } else {
            this.showAlert(context);
          }
          break;
        }

        case 'com.nexus.streamdeck.raid-alert': {
          if (this.raidTarget) {
            const target = this.raidTarget;
            const targetId = this.raidTargetId;
            this.raidTarget = null;
            this.raidTargetId = null;
            this.setState(context, 0);
            await nexusFetch('/api/streamdeck/raid-consume', key, { method: 'POST', body: JSON.stringify({ raidId: targetId }) });
            await nexusFetch('/api/streamdeck/raid-execute', key, { method: 'POST', body: JSON.stringify({ toUsername: target }) });
            this.showOk(context);
          }
          break;
        }

        default:
          break;
      }
    } catch {
      this.showAlert(context);
    }
  }

  startPolling() {
    this.pollTimer = setInterval(() => this.pollAll(), POLL_INTERVAL_MS);
  }

  async cacheProfileImage(username, url) {
    try {
      const res = await fetch(url);
      const buf = await res.arrayBuffer();
      const b64 = Buffer.from(buf).toString('base64');
      const mime = url.includes('.png') ? 'image/png' : 'image/jpeg';
      this.profileImageCache.set(username, `data:${mime};base64,${b64}`);
    } catch {}
  }

  async pollAll() {
    this.send({ event: 'getGlobalSettings', context: this.pluginUUID });

    const key = this.globalApiKey;
    if (!key || !this.contexts.size) return;

    try {
      const [stream, team, chatRate, raidStatus] = await Promise.all([
        nexusFetch('/api/streamdeck/stream-data', key),
        nexusFetch('/api/streamdeck/team', key),
        nexusFetch('/api/streamdeck/chat-rate', key),
        nexusFetch('/api/streamdeck/raid-status', key),
      ]);

      const liveTeam = team.members?.filter(m => m.isLive) || [];
      this.streamData[key] = {
        ...stream,
        liveTeam,
        chatRate: chatRate.currentRate || 0,
        autoThreshold: chatRate.autoThreshold || 3,
      };

      // Kick off profile image downloads for uncached live members (fire-and-forget)
      for (const member of liveTeam) {
        if (member.profileImageUrl && !this.profileImageCache.has(member.username)) {
          this.cacheProfileImage(member.username, member.profileImageUrl);
        }
      }

      if (raidStatus.incomingRaid) {
        this.raidTarget = raidStatus.incomingRaid.from;
        this.raidTargetId = raidStatus.incomingRaid.id;
      } else {
        this.raidTarget = null;
        this.raidTargetId = null;
      }

      for (const [ctx] of this.contexts) {
        this.refreshContext(ctx, key);
      }
    } catch {}
  }

  refreshContext(ctx, key) {
    const info = this.contexts.get(ctx);
    if (!info) return;
    const { action, settings } = info;
    const k = key || this.globalApiKey || settings.apiKey;
    const sd = k ? this.streamData[k] : null;

    switch (action) {

      case 'com.nexus.streamdeck.raid-radar': {
        if (!sd?.liveTeam?.length) {
          this.setTitle(ctx, 'No live\nteam');
          this.setImage(ctx, this.drawRaidRadarIdle());
          break;
        }
        const idx = (sd.radarIndex || 0) % sd.liveTeam.length;
        sd.radarDisplay = idx;                            // what the key shows NOW
        sd.radarIndex = (idx + 1) % sd.liveTeam.length; // advance for next cycle
        const m = sd.liveTeam[idx];
        this.setTitle(ctx, '');
        this.setImage(ctx, this.drawRaidRadar(m));
        break;
      }

      case 'com.nexus.streamdeck.chat-pulse': {
        const rate = sd?.chatRate || 0;
        const threshold = sd?.autoThreshold || 3;
        const intensity = Math.min(1, rate / (threshold * 2));
        this.setTitle(ctx, '');
        this.setImage(ctx, this.drawChatPulse(rate, intensity));
        break;
      }

      case 'com.nexus.streamdeck.viewer-milestone': {
        if (!sd) break;
        const viewers = sd.viewers || 0;
        const peak = Math.max(this.sessionPeaks[ctx] || 0, viewers);
        this.sessionPeaks[ctx] = peak;
        const isRecord = viewers > 0 && viewers >= peak;
        this.setTitle(ctx, '');
        this.setImage(ctx, this.drawViewerMilestone(viewers, peak, isRecord));
        this.setState(ctx, isRecord ? 1 : 0);
        break;
      }

      case 'com.nexus.streamdeck.stream-score': {
        if (!sd) break;
        const grade = calcStreamScore(sd);
        this.setTitle(ctx, '');
        this.setImage(ctx, this.drawStreamScore(grade));
        break;
      }

      case 'com.nexus.streamdeck.raid-alert': {
        if (this.raidTarget) {
          this.setState(ctx, 1);
          this.setTitle(ctx, this.raidTarget.slice(0, 10));
        } else {
          this.setState(ctx, 0);
          this.setTitle(ctx, '');
        }
        break;
      }

      default: break;
    }
  }

  // ── SVG key image renderers ──────────────────────────────────────────────

  drawRaidRadarIdle() {
    return svgToBase64(`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144">
      <rect width="144" height="144" rx="14" fill="#0d0914"/>
      <circle cx="72" cy="58" r="34" fill="none" stroke="#a78bfa" stroke-width="1" opacity="0.25"/>
      <circle cx="72" cy="58" r="22" fill="none" stroke="#a78bfa" stroke-width="1" opacity="0.35"/>
      <circle cx="72" cy="58" r="10" fill="none" stroke="#a78bfa" stroke-width="1" opacity="0.5"/>
      <line x1="72" y1="24" x2="72" y2="92" stroke="#a78bfa" stroke-width="1" opacity="0.2"/>
      <line x1="38" y1="58" x2="106" y2="58" stroke="#a78bfa" stroke-width="1" opacity="0.2"/>
      <line x1="72" y1="58" x2="100" y2="35" stroke="#a78bfa" stroke-width="2.5"
            stroke-linecap="round" opacity="0.65"/>
      <circle cx="72" cy="58" r="3.5" fill="#a78bfa"/>
      <text x="72" y="110" text-anchor="middle" font-family="Arial" font-size="16"
            font-weight="700" fill="#a78bfa" opacity="0.6">NO LIVE TEAM</text>
    </svg>`);
  }

  drawRaidRadar(member) {
    const name = (member.displayName || '').slice(0, 12);
    const viewers = member.viewerCount || 0;
    const img = this.profileImageCache.get(member.username);

    if (img) {
      return svgToBase64(`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144">
        <rect width="144" height="144" rx="14" fill="#0d0914"/>
        <defs><clipPath id="cp"><circle cx="72" cy="40" r="34"/></clipPath></defs>
        <image href="${img}" x="38" y="6" width="68" height="68"
               clip-path="url(#cp)" preserveAspectRatio="xMidYMid slice"/>
        <circle cx="72" cy="40" r="34" fill="none" stroke="#a78bfa" stroke-width="2.5"/>
        <rect x="8" y="82" width="128" height="1" fill="#a78bfa" opacity="0.2"/>
        <text x="72" y="106" text-anchor="middle" font-family="Arial" font-size="20"
              font-weight="700" fill="#bf94ff">${name}</text>
        <text x="72" y="130" text-anchor="middle" font-family="Arial" font-size="18"
              fill="#8a7ab0">${viewers} viewers</text>
      </svg>`);
    }

    // Fallback while image loads
    return svgToBase64(`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144">
      <rect width="144" height="144" rx="14" fill="#0d0914"/>
      <circle cx="72" cy="50" r="30" fill="none" stroke="#a78bfa" stroke-width="1" opacity="0.3"/>
      <circle cx="72" cy="50" r="18" fill="none" stroke="#a78bfa" stroke-width="1" opacity="0.4"/>
      <circle cx="72" cy="50" r="3.5" fill="#a78bfa"/>
      <line x1="72" y1="50" x2="97" y2="29" stroke="#a78bfa" stroke-width="2.5"
            stroke-linecap="round" opacity="0.7"/>
      <rect x="8" y="88" width="128" height="1" fill="#a78bfa" opacity="0.2"/>
      <text x="72" y="110" text-anchor="middle" font-family="Arial" font-size="20"
            font-weight="700" fill="#bf94ff">${name}</text>
      <text x="72" y="133" text-anchor="middle" font-family="Arial" font-size="18"
            fill="#8a7ab0">${viewers}v</text>
    </svg>`);
  }

  drawChatPulse(rate, intensity) {
    const color = intensity > 0.75 ? '#f87171' : intensity > 0.4 ? '#fbbf24' : '#a78bfa';
    const barHeights = [0.45, 0.7, 1.0, 0.75, 0.5];
    const bars = barHeights.map((base, i) => {
      const h = Math.max(8, Math.round(38 * (base * 0.35 + Math.max(0.12, intensity) * base * 0.65)));
      const x = 38 + i * 16;
      const y = 72 - h;
      return `<rect x="${x}" y="${y}" width="11" height="${h}" rx="3" fill="${color}" opacity="${(0.3 + intensity * 0.6).toFixed(2)}"/>`;
    }).join('');
    return svgToBase64(`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144">
      <rect width="144" height="144" rx="12" fill="#0b0710"/>
      <ellipse cx="72" cy="52" rx="40" ry="24" fill="${color}" opacity="${(0.04 + intensity * 0.07).toFixed(2)}"/>
      ${bars}
      <text x="72" y="102" text-anchor="middle" font-family="Arial" font-size="26"
            font-weight="700" fill="${color}">${rate}</text>
      <text x="72" y="124" text-anchor="middle" font-family="Arial" font-size="18"
            fill="${color}" opacity="0.65">msgs / 30s</text>
    </svg>`);
  }

  drawViewerMilestone(viewers, peak, isRecord) {
    const color = isRecord ? '#facc15' : '#a78bfa';
    const label = isRecord ? '★ NEW PEAK' : 'pk ' + peak;
    return svgToBase64(`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144">
      <rect width="144" height="144" rx="14" fill="#0d0914"/>
      <text x="72" y="62" text-anchor="middle" font-family="Arial" font-size="46"
            fill="${color}" opacity="0.9">★</text>
      <text x="72" y="100" text-anchor="middle" font-family="Arial" font-size="28"
            font-weight="700" fill="${color}">${viewers}</text>
      <text x="72" y="125" text-anchor="middle" font-family="Arial" font-size="16"
            fill="${color}" opacity="0.65">${label}</text>
    </svg>`);
  }

  drawStreamScore(grade) {
    const color = { A: '#4ade80', B: '#a3e635', C: '#facc15', D: '#fb923c', F: '#f87171', '?': '#4a4a6a' }[grade] || '#888';
    return svgToBase64(`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144">
      <rect width="144" height="144" rx="14" fill="#0d0914"/>
      <circle cx="72" cy="60" r="46" fill="${color}" opacity="0.1"/>
      <circle cx="72" cy="60" r="30" fill="${color}" opacity="0.08"/>
      <text x="72" y="82" text-anchor="middle" font-family="Arial Black" font-size="56"
            font-weight="900" fill="${color}">${grade}</text>
      <text x="72" y="118" text-anchor="middle" font-family="Arial" font-size="18"
            font-weight="700" fill="${color}" opacity="0.7">STREAM SCORE</text>
    </svg>`);
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

const args = process.argv;
const portIdx = args.indexOf('-port');
const uuidIdx = args.indexOf('-pluginUUID');

if (portIdx === -1 || uuidIdx === -1) {
  console.error('Missing -port or -pluginUUID arguments');
  process.exit(1);
}

const plugin = new NexusPlugin();
plugin.connect(args[portIdx + 1], args[uuidIdx + 1]);
