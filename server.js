const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.static("public"));
app.get("/health", (_req, res) => res.json({ ok: true }));

// In-memory rooms: suitable for a small game/demo. Rooms reset when server restarts.
const rooms = new Map();

// IP-based session persistence: maps "ip:roomCode" -> session object
// Sessions expire 2 hours after the player disconnects.
const ipSessions = new Map();

const cleanName = (v, max = 24) => String(v || "").trim().slice(0, max);
const roomCode = (v) => String(v || "").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 12);
const safeNum = (v, min, max, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};

/** Generate a unique 4-digit PIN not already in use within this room. */
function generatePin(room) {
  let pin;
  const usedPins = new Set([...room.players.values()].map(p => p.pin).filter(Boolean));
  do {
    pin = String(Math.floor(1000 + Math.random() * 9000));
  } while (usedPins.has(pin));
  return pin;
}

/** Normalize an IPv6-mapped IPv4 address (::ffff:1.2.3.4 → 1.2.3.4). */
function normalizeIP(ip) {
  if (!ip) return "unknown";
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

/** Key used for ipSessions map. */
function sessionKey(ip, code) {
  return `${ip}:${code}`;
}

/**
 * Public view of a player (sent to all clients).
 * Includes caught status; PIN is intentionally omitted for privacy.
 */
function publicPlayer(p) {
  return {
    id: p.id,
    username: p.username,
    team: p.team,
    connected: p.connected,
    hasLocation: !!p.location,
    lastSeen: p.lastSeen || null,
    caught: !!p.caught
  };
}

function roomState(room) {
  return {
    code: room.code,
    status: room.status,
    settings: room.settings,
    startedAt: room.startedAt,
    endsAt: room.endsAt,
    players: [...room.players.values()].map(publicPlayer)
  };
}

function emitRoom(room) {
  io.to(room.code).emit("room-state", roomState(room));
}

function ensureRoom(code) {
  let room = rooms.get(code);
  if (!room) {
    room = {
      code,
      status: "lobby",
      players: new Map(),
      settings: { durationMin: 30, hiderPingSec: 60, seekerPingSec: 120 },
      startedAt: null,
      endsAt: null,
      pingTimers: {},
      endTimer: null
    };
    rooms.set(code, room);
  }
  return room;
}

function clearPings(room) {
  for (const timer of Object.values(room.pingTimers)) clearInterval(timer);
  room.pingTimers = {};
}

/**
 * Broadcast the location of all (non-caught) players on `teamWithLocation`
 * to every player on the opposing team.
 * Caught hiders are excluded from pings.
 */
function broadcastPings(room, teamWithLocation) {
  if (room.status !== "playing") return;
  const recipientsTeam = teamWithLocation === "hiders" ? "seekers" : "hiders";
  const players = [...room.players.values()];
  const locations = players
    .filter(p => p.team === teamWithLocation && p.location && !p.caught)
    .map(p => ({
      id: p.id, username: p.username, team: p.team,
      lat: p.location.lat, lon: p.location.lon,
      accuracy: p.location.accuracy, capturedAt: p.location.capturedAt
    }));
  // Only the opposing team receives the coordinates.
  for (const p of players) {
    if (p.team === recipientsTeam && !p.caught) {
      io.to(p.id).emit("location-ping", {
        sourceTeam: teamWithLocation,
        locations,
        sentAt: Date.now(),
        nextPingSec: teamWithLocation === "hiders"
          ? room.settings.hiderPingSec : room.settings.seekerPingSec
      });
    }
  }
}

function startPings(room) {
  clearPings(room);
  // First ping happens immediately, then repeats at the configured interval.
  broadcastPings(room, "hiders");
  broadcastPings(room, "seekers");
  room.pingTimers.hiders = setInterval(
    () => broadcastPings(room, "hiders"), room.settings.hiderPingSec * 1000
  );
  room.pingTimers.seekers = setInterval(
    () => broadcastPings(room, "seekers"), room.settings.seekerPingSec * 1000
  );
}

function endGame(room) {
  clearPings(room);
  room.status = "ended";
  emitRoom(room);
  io.to(room.code).emit("game-ended", { message: "Game time is up." });
  // Clean up all IP sessions for this room when it ends.
  for (const [key] of ipSessions) {
    if (key.endsWith(`:${room.code}`)) {
      ipSessions.delete(key);
    }
  }
}

/** Save a player's session so they can rejoin as the same person after a disconnect. */
function saveSession(ip, code, player) {
  const key = sessionKey(ip, code);
  // Cancel any existing cleanup timer for this key.
  const existing = ipSessions.get(key);
  if (existing && existing._cleanupTimer) clearTimeout(existing._cleanupTimer);

  const session = {
    username: player.username,
    team: player.team,
    location: player.location,
    pin: player.pin || null,
    caught: player.caught || false,
    lastSeen: Date.now(),
    _cleanupTimer: null
  };
  // Auto-delete session after 2 hours.
  session._cleanupTimer = setTimeout(() => ipSessions.delete(key), 7200000);
  ipSessions.set(key, session);
}

// ─── Socket.io event handlers ─────────────────────────────────────────────────

io.on("connection", socket => {
  // Extract and normalize the connecting client's IP address.
  const rawIP = socket.handshake.address || socket.request.socket.remoteAddress || "unknown";
  const clientIP = normalizeIP(rawIP);

  socket.on("join-room", (data, cb = () => {}) => {
    const code = roomCode(data?.room);
    let username = cleanName(data?.username);
    let team = data?.team === "seekers" ? "seekers" : "hiders";
    if (!code || code.length < 3) return cb({ ok: false, error: "Room ID must be at least 3 letters/numbers." });
    if (!username) return cb({ ok: false, error: "Enter a username." });

    // Leave any previous room cleanly.
    if (socket.data.room) {
      const old = rooms.get(socket.data.room);
      if (old) {
        old.players.delete(socket.id);
        emitRoom(old);
        if (old.players.size === 0) { clearPings(old); rooms.delete(old.code); }
      }
      socket.leave(socket.data.room);
    }

    const room = ensureRoom(code);
    if (room.status === "ended") return cb({ ok: false, error: "This game has ended. Create a new room ID." });

    // ── IP session restoration ────────────────────────────────────────────────
    const key = sessionKey(clientIP, code);
    const session = ipSessions.get(key);
    let restoredSession = false;

    if (session) {
      // Cancel the auto-cleanup timer; the player is back.
      if (session._cleanupTimer) clearTimeout(session._cleanupTimer);
      ipSessions.delete(key); // We'll re-save on next disconnect if needed.
      // Restore from session (username/team/pin/caught/location from saved state).
      username = session.username;
      team = session.team;
      restoredSession = true;
    }

    // Remove any stale socket entry for this logical player (same IP+room).
    // This handles the case where the old socket is still technically present.
    for (const [sid, p] of room.players) {
      if (p._ip === clientIP) {
        room.players.delete(sid);
        break;
      }
    }

    // Assign a PIN to hiders (restore from session if available, else generate fresh).
    let pin = null;
    if (team === "hiders") {
      pin = (restoredSession && session.pin) ? session.pin : generatePin(room);
    }

    const player = {
      id: socket.id,
      _ip: clientIP,          // internal — not sent to clients
      username,
      team,
      connected: true,
      location: (restoredSession && session.location) ? session.location : null,
      caught: restoredSession ? (session.caught || false) : false,
      pin,                    // only for hiders
      lastSeen: Date.now()
    };

    room.players.set(socket.id, player);
    socket.join(code);
    socket.data.room = code;

    // Tell the joining player their own PIN (hiders only) and whether session was restored.
    cb({
      ok: true,
      state: roomState(room),
      playerId: socket.id,
      team: player.team,
      pin: player.pin || null,       // null for seekers
      restored: restoredSession
    });
    emitRoom(room);

    if (room.status === "playing") {
      socket.emit("game-already-playing", {
        startedAt: room.startedAt,
        endsAt: room.endsAt,
        settings: room.settings
      });
    }
  });

  socket.on("update-settings", (data, cb = () => {}) => {
    const room = rooms.get(socket.data.room);
    if (!room) return cb({ ok: false, error: "Join a room first." });
    if (room.status !== "lobby") return cb({ ok: false, error: "Settings can only be changed in the lobby." });
    room.settings = {
      durationMin: safeNum(data?.durationMin, 1, 240, 30),
      hiderPingSec: safeNum(data?.hiderPingSec, 10, 3600, 60),
      seekerPingSec: safeNum(data?.seekerPingSec, 10, 3600, 120)
    };
    emitRoom(room);
    cb({ ok: true });
  });

  socket.on("start-game", (_data, cb = () => {}) => {
    const room = rooms.get(socket.data.room);
    if (!room) return cb({ ok: false, error: "Join a room first." });
    if (room.status !== "lobby") return cb({ ok: false, error: "Game has already started." });
    const hiders = [...room.players.values()].filter(p => p.team === "hiders").length;
    const seekers = [...room.players.values()].filter(p => p.team === "seekers").length;
    if (!hiders || !seekers) return cb({ ok: false, error: "You need at least one hider and one seeker to start." });
    room.status = "playing";
    room.startedAt = Date.now();
    room.endsAt = room.startedAt + room.settings.durationMin * 60 * 1000;
    startPings(room);
    emitRoom(room);
    room.endTimer = setTimeout(() => endGame(room), room.settings.durationMin * 60 * 1000);
    cb({ ok: true });
  });

  socket.on("location-update", data => {
    const room = rooms.get(socket.data.room);
    if (!room || room.status !== "playing") return;
    const p = room.players.get(socket.id);
    if (!p || p.caught) return; // Caught players no longer share location.
    if (!Number.isFinite(Number(data?.lat)) || !Number.isFinite(Number(data?.lon))) return;
    const lat = Number(data.lat), lon = Number(data.lon);
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return;
    p.location = {
      lat, lon,
      accuracy: safeNum(data.accuracy, 0, 100000, 0),
      capturedAt: Date.now()
    };
    p.lastSeen = Date.now();

    // ── Teammate real-time location sharing ────────────────────────────────
    // Broadcast this player's location immediately to their own teammates only.
    const teammateLoc = {
      id: p.id, username: p.username, team: p.team,
      lat: p.location.lat, lon: p.location.lon,
      accuracy: p.location.accuracy, capturedAt: p.location.capturedAt
    };
    for (const teammate of room.players.values()) {
      if (teammate.id !== socket.id && teammate.team === p.team && !teammate.caught) {
        io.to(teammate.id).emit("teammate-location", teammateLoc);
      }
    }
    // Opposing-team coordinates are NOT broadcast immediately; they go out on the scheduled ping timer.
  });

  /**
   * catch-hider: A seeker submits a PIN to catch a hider.
   * Payload: { pin: "1234" }
   * Response: { ok: true, caughtPlayer: { username, team } } | { ok: false, error: "..." }
   */
  socket.on("catch-hider", (data, cb = () => {}) => {
    const room = rooms.get(socket.data.room);
    if (!room) return cb({ ok: false, error: "Join a room first." });
    if (room.status !== "playing") return cb({ ok: false, error: "Game is not currently active." });

    const catcher = room.players.get(socket.id);
    if (!catcher || catcher.team !== "seekers") return cb({ ok: false, error: "Only seekers can catch hiders." });

    const pin = String(data?.pin || "").trim();
    if (!/^\d{4}$/.test(pin)) return cb({ ok: false, error: "PIN must be a 4-digit number." });

    // Find the hider with this PIN.
    let target = null;
    for (const p of room.players.values()) {
      if (p.team === "hiders" && p.pin === pin && !p.caught) {
        target = p;
        break;
      }
    }
    if (!target) return cb({ ok: false, error: "Invalid PIN or hider already caught." });

    // Mark as caught.
    target.caught = true;
    target.location = null; // Stop sharing their location.

    // Tell the caught hider directly.
    io.to(target.id).emit("you-were-caught", {
      message: "You have been caught! You are out.",
      caughtBy: catcher.username
    });

    // Broadcast updated room state to everyone.
    emitRoom(room);

    cb({ ok: true, caughtPlayer: { username: target.username, team: target.team } });
  });

  socket.on("leave-room", () => {
    const code = socket.data.room;
    const room = rooms.get(code);
    if (!room) return;
    // When explicitly leaving, remove session too (no rejoin needed).
    const key = sessionKey(clientIP, code);
    const session = ipSessions.get(key);
    if (session && session._cleanupTimer) clearTimeout(session._cleanupTimer);
    ipSessions.delete(key);

    room.players.delete(socket.id);
    socket.leave(code);
    socket.data.room = null;
    emitRoom(room);
    if (room.players.size === 0) {
      clearPings(room);
      if (room.endTimer) clearTimeout(room.endTimer);
      rooms.delete(code);
    }
  });

  socket.on("disconnect", () => {
    const code = socket.data.room;
    const room = rooms.get(code);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (player) {
      // Persist session for 2 hours so the player can rejoin as the same person.
      saveSession(clientIP, code, player);
      room.players.delete(socket.id);
    }
    emitRoom(room);
    if (room.players.size === 0) {
      clearPings(room);
      if (room.endTimer) clearTimeout(room.endTimer);
      rooms.delete(code);
    }
  });
});

server.listen(PORT, () => console.log(`Manhunt running on http://localhost:${PORT}`));
