// ============================================================================
// ARENA BREAKER - AUTHORITATIVE WEBSOCKET MULTIPLAYER SERVER (MAX 5 PLAYERS)
// ============================================================================
const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const MAX_PLAYERS_PER_ROOM = 5;

// Health check endpoint for hosting platforms
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  let totalPlayers = 0;
  rooms.forEach(r => { totalPlayers += r.players.size; });
  res.end(JSON.stringify({
    status: 'online',
    server: 'Arena Breaker Dedicated Multiplayer Server',
    maxPlayersPerRoom: MAX_PLAYERS_PER_ROOM,
    activeRooms: rooms.size,
    totalPlayersOnline: totalPlayers,
    timestamp: new Date().toISOString()
  }));
});

const wss = new WebSocket.Server({ server });

const PLAYER_CONFIGS = [
  { role: 'P1', name: 'Green Vanguard', color: '#22c55e', hex: 0x22c55e, spawn: { x: 0, z: 12 } },
  { role: 'P2', name: 'Cyan Striker',   color: '#06b6d4', hex: 0x06b6d4, spawn: { x: 0, z: -12 } },
  { role: 'P3', name: 'Amber Phantom',  color: '#f59e0b', hex: 0xf59e0b, spawn: { x: 12, z: 0 } },
  { role: 'P4', name: 'Purple Enforcer',color: '#a855f7', hex: 0xa855f7, spawn: { x: -12, z: 0 } },
  { role: 'P5', name: 'Rose Sentinel',  color: '#f43f5e', hex: 0xf43f5e, spawn: { x: 8, z: 8 } }
];

const rooms = new Map();
let nextBulletId = 1;

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id: roomId,
      players: new Map(),
      bullets: [],
      lastTick: Date.now()
    });
  }
  return rooms.get(roomId);
}

function broadcastToRoom(room, message, excludeWs = null) {
  const jsonStr = JSON.stringify(message);
  room.players.forEach((player, clientWs) => {
    if (clientWs !== excludeWs && clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(jsonStr);
    }
  });
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  let currentRoom = null;
  let playerState = null;

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);

      switch (msg.type) {
        case 'join': {
          const roomId = (msg.roomId || 'arena-1').trim().toLowerCase();
          const room = getOrCreateRoom(roomId);

          if (room.players.size >= MAX_PLAYERS_PER_ROOM) {
            ws.send(JSON.stringify({
              type: 'error',
              code: 'ROOM_FULL',
              message: `Room "${roomId}" is full (${MAX_PLAYERS_PER_ROOM}/${MAX_PLAYERS_PER_ROOM} players). Please select or create another room.`
            }));
            return;
          }

          const usedRoles = new Set(Array.from(room.players.values()).map(p => p.role));
          const slot = PLAYER_CONFIGS.find(cfg => !usedRoles.has(cfg.role)) || PLAYER_CONFIGS[0];

          playerState = {
            id: 'player_' + Math.random().toString(36).substring(2, 9),
            role: slot.role,
            name: msg.playerName ? msg.playerName.trim().substring(0, 15) : slot.name,
            color: slot.color,
            hex: slot.hex,
            x: slot.spawn.x,
            z: slot.spawn.z,
            aimAngle: 0,
            hp: 100,
            maxHp: 100,
            kills: 0,
            deaths: 0,
            spawn: slot.spawn
          };

          currentRoom = room;
          room.players.set(ws, playerState);

          const existingPlayers = Array.from(room.players.values()).map(p => ({
            id: p.id,
            role: p.role,
            name: p.name,
            color: p.color,
            hex: p.hex,
            x: p.x,
            z: p.z,
            aimAngle: p.aimAngle,
            hp: p.hp,
            maxHp: p.maxHp,
            kills: p.kills,
            deaths: p.deaths
          }));

          ws.send(JSON.stringify({
            type: 'welcome',
            roomId: room.id,
            maxPlayers: MAX_PLAYERS_PER_ROOM,
            self: playerState,
            players: existingPlayers
          }));

          broadcastToRoom(room, {
            type: 'player_joined',
            player: playerState
          }, ws);
          break;
        }

        case 'move': {
          if (!currentRoom || !playerState || playerState.hp <= 0) return;
          playerState.x = Math.max(-22, Math.min(22, msg.x || 0));
          playerState.z = Math.max(-22, Math.min(22, msg.z || 0));
          playerState.aimAngle = msg.aimAngle || 0;

          broadcastToRoom(currentRoom, {
            type: 'player_moved',
            id: playerState.id,
            x: playerState.x,
            z: playerState.z,
            aimAngle: playerState.aimAngle
          }, ws);
          break;
        }

        case 'shoot': {
          if (!currentRoom || !playerState || playerState.hp <= 0) return;
          const origin = msg.origin || { x: playerState.x, y: 1.0, z: playerState.z };
          const dir = msg.dir || { x: Math.sin(playerState.aimAngle), y: 0, z: Math.cos(playerState.aimAngle) };

          const len = Math.hypot(dir.x, dir.z) || 1;
          const normX = dir.x / len;
          const normZ = dir.z / len;

          const bullet = {
            id: nextBulletId++,
            ownerId: playerState.id,
            x: origin.x,
            z: origin.z,
            vx: normX * 32,
            vz: normZ * 32,
            damage: 20,
            life: 1.5,
            consumed: false
          };
          currentRoom.bullets.push(bullet);

          broadcastToRoom(currentRoom, {
            type: 'player_shot',
            bulletId: bullet.id,
            ownerId: playerState.id,
            origin: origin,
            dir: { x: normX, y: 0, z: normZ }
          });
          break;
        }

        case 'ping': {
          ws.send(JSON.stringify({ type: 'pong', time: Date.now() }));
          break;
        }
      }
    } catch (err) {
      console.error('Error handling WebSocket message:', err);
    }
  });

  ws.on('close', () => {
    if (currentRoom && playerState) {
      currentRoom.players.delete(ws);
      broadcastToRoom(currentRoom, {
        type: 'player_left',
        id: playerState.id,
        name: playerState.name
      });

      if (currentRoom.players.size === 0) {
        rooms.delete(currentRoom.id);
      }
    }
  });
});

// Authoritative Physics and Hit Detection (30 FPS)
const TICK_RATE = 30;
const DT = 1 / TICK_RATE;

setInterval(() => {
  rooms.forEach((room) => {
    if (room.players.size === 0) return;

    for (let i = room.bullets.length - 1; i >= 0; i--) {
      const b = room.bullets[i];
      b.x += b.vx * DT;
      b.z += b.vz * DT;
      b.life -= DT;

      if (Math.abs(b.x) > 23.5 || Math.abs(b.z) > 23.5 || b.life <= 0) {
        room.bullets.splice(i, 1);
        continue;
      }

      let hitOccurred = false;
      for (const [clientWs, targetPlayer] of room.players.entries()) {
        if (targetPlayer.id === b.ownerId || targetPlayer.hp <= 0) continue;

        const dist = Math.hypot(b.x - targetPlayer.x, b.z - targetPlayer.z);
        if (dist < 0.95) {
          b.consumed = true;
          hitOccurred = true;

          targetPlayer.hp = Math.max(0, targetPlayer.hp - b.damage);

          broadcastToRoom(room, {
            type: 'hit',
            bulletId: b.id,
            targetId: targetPlayer.id,
            damage: b.damage,
            newHp: targetPlayer.hp,
            hitPos: { x: b.x, y: 1.0, z: b.z }
          });

          if (targetPlayer.hp <= 0) {
            targetPlayer.deaths++;
            for (const p of room.players.values()) {
              if (p.id === b.ownerId) {
                p.kills++;
                break;
              }
            }

            broadcastToRoom(room, {
              type: 'player_killed',
              killerId: b.ownerId,
              victimId: targetPlayer.id
            });

            setTimeout(() => {
              if (room.players.has(clientWs)) {
                targetPlayer.hp = 100;
                targetPlayer.x = targetPlayer.spawn.x;
                targetPlayer.z = targetPlayer.spawn.z;
                broadcastToRoom(room, {
                  type: 'player_respawned',
                  player: targetPlayer
                });
              }
            }, 3000);
          }
          break;
        }
      }

      if (hitOccurred) {
        room.bullets.splice(i, 1);
      }
    }
  });
}, 1000 / TICK_RATE);

// Keepalive heartbeat
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
