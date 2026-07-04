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
    this.raidTarget = null;   // pending incoming raid
    this.sessionPeaks = {};   // context → peak viewer count this session
    this.globalApiKey = null; // shared API key across all actions
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
      const hasKey = !!(this.globalApiKey || s.apiKey);
      this.setTitle(context, hasKey ? 'KEY OK' : 'NO KEY');
      setTimeout(() => this.refreshContext(context), 2000);
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
    // Debug: show key status as title briefly
    this.setTitle(context, key ? 'KEY OK' : 'NO KEY');
    setTimeout(() => this.setTitle(context, ''), 3000);
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
            const target = sd.liveTeam[sd.radarIndex || 0];
            await nexusFetch('/raids/execute', key, { method: 'POST', body: JSON.stringify({ toUsername: target.username }) });
            this.showOk(context);
          } else {
            this.showAlert(context);
          }
          break;
        }

        case 'com.nexus.streamdeck.raid-alert': {
          if (this.raidTarget) {
            await nexusFetch('/raids/execute', key, { method: 'POST', body: JSON.stringify({ toUsername: this.raidTarget }) });
            this.raidTarget = null;
            this.setState(context, 0);
            this.showOk(context);
          }
          break;
        }

        case 'com.nexus.streamdeck.team-shoutout': {
          const member = settings.member;
          if (!member) { this.showAlert(context); break; }
          await nexusFetch('/api/streamdeck/shoutout', key, { method: 'POST', body: JSON.stringify({ username: member }) });
          this.showOk(context);
          break;
        }

        case 'com.nexus.streamdeck.category-switcher': {
          const { categoryId, categoryName } = settings;
          if (!categoryId) { this.showAlert(context); break; }
          await nexusFetch('/api/streamdeck/category', key, { method: 'PATCH', body: JSON.stringify({ game_id: categoryId }) });
          this.setTitle(context, categoryName || 'Switched');
          this.showOk(context);
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

  async pollAll() {
    this.send({ event: 'getGlobalSettings', context: this.pluginUUID });

    const key = this.globalApiKey;
    if (!key || !this.contexts.size) return;

    try {
      const [stream, team, rate] = await Promise.all([
        nexusFetch('/api/streamdeck/stream-data', key),
        nexusFetch('/api/streamdeck/team', key),
        nexusFetch('/streams/auto-clip-rate', key),
      ]);

      this.streamData[key] = {
        ...stream,
        liveTeam: team.members?.filter(m => m.isLive) || [],
        chatRate: rate.currentRate || 0,
        autoThreshold: rate.autoThreshold || 3,
      };

      for (const [ctx] of this.contexts) {
        this.refreshContext(ctx, key);
      }
    } catch {}
  }

  refreshContext(ctx, key) {
    const info = this.contexts.get(ctx);
    if (!info) return;
    const { action, settings } = info;
    const k = key || settings.apiKey;
    const sd = k ? this.streamData[k] : null;

    switch (action) {

      case 'com.nexus.streamdeck.raid-radar': {
        if (!sd?.liveTeam?.length) { this.setTitle(ctx, 'No live\nteam'); break; }
        const idx = (sd.radarIndex || 0) % sd.liveTeam.length;
        sd.radarIndex = (idx + 1) % sd.liveTeam.length; // advance for next poll
        const m = sd.liveTeam[idx];
        this.setTitle(ctx, m.displayName + '\n' + m.viewerCount + 'v');
        this.setImage(ctx, this.drawRaidRadar(m));
        break;
      }

      case 'com.nexus.streamdeck.chat-pulse': {
        const rate = sd?.chatRate || 0;
        const threshold = sd?.autoThreshold || 3;
        const intensity = Math.min(1, rate / (threshold * 2));
        this.setImage(ctx, this.drawChatPulse(intensity));
        this.setTitle(ctx, rate + '/30s');
        break;
      }

      case 'com.nexus.streamdeck.viewer-milestone': {
        if (!sd) break;
        const viewers = sd.viewers || 0;
        const peak = Math.max(this.sessionPeaks[ctx] || 0, viewers);
        this.sessionPeaks[ctx] = peak;
        const isRecord = viewers > 0 && viewers >= peak;
        this.setTitle(ctx, viewers + (isRecord ? '\n★ PEAK' : '\npk ' + peak));
        this.setState(ctx, isRecord ? 1 : 0);
        break;
      }

      case 'com.nexus.streamdeck.stream-score': {
        if (!sd) break;
        const grade = calcStreamScore(sd);
        this.setImage(ctx, this.drawStreamScore(grade));
        break;
      }

      default: break;
    }
  }

  // ── SVG key image renderers ──────────────────────────────────────────────

  drawRaidRadar(member) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144">
      <rect width="144" height="144" rx="12" fill="#1a0a2e"/>
      <circle cx="72" cy="52" r="24" fill="#9147ff" opacity="0.2"/>
      <circle cx="72" cy="52" r="16" fill="#9147ff" opacity="0.5"/>
      <text x="72" y="57" text-anchor="middle" font-family="Arial" font-size="16" font-weight="bold" fill="#fff">⚔</text>
      <rect x="8" y="88" width="128" height="2" fill="#9147ff" opacity="0.3"/>
      <text x="72" y="108" text-anchor="middle" font-family="Arial" font-size="11" fill="#bf94ff">${member.displayName}</text>
      <text x="72" y="126" text-anchor="middle" font-family="Arial" font-size="10" fill="#6a5a9a">${member.viewerCount} viewers</text>
    </svg>`;
    return svgToBase64(svg);
  }

  drawChatPulse(intensity) {
    const r = Math.round(255 * intensity);
    const g = Math.round(71 + (184 * (1 - intensity)));
    const b = Math.round(255 * (1 - intensity * 0.6));
    const color = `rgb(${r},${g},${b})`;
    const rings = [0.3, 0.55, 0.8].map((scale, i) => {
      const op = intensity * (1 - i * 0.25);
      const r2 = Math.round(62 * scale);
      return `<circle cx="72" cy="72" r="${r2}" fill="none" stroke="${color}" stroke-width="2" opacity="${op}"/>`;
    }).join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144">
      <rect width="144" height="144" rx="12" fill="#0b0710"/>
      ${rings}
      <circle cx="72" cy="72" r="18" fill="${color}" opacity="${0.15 + intensity * 0.5}"/>
      <text x="72" y="78" text-anchor="middle" font-family="Arial" font-size="18" fill="${color}">💬</text>
    </svg>`;
    return svgToBase64(svg);
  }

  drawStreamScore(grade) {
    const color = scoreColor(grade);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144">
      <rect width="144" height="144" rx="12" fill="#0b0710"/>
      <circle cx="72" cy="62" r="44" fill="${color}" opacity="0.12"/>
      <circle cx="72" cy="62" r="36" fill="${color}" opacity="0.08"/>
      <text x="72" y="80" text-anchor="middle" font-family="Arial Black" font-size="52" font-weight="900" fill="${color}">${grade}</text>
      <text x="72" y="118" text-anchor="middle" font-family="Arial" font-size="11" fill="${color}" opacity="0.7">STREAM SCORE</text>
    </svg>`;
    return svgToBase64(svg);
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
