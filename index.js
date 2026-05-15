const { WebSocketServer } = require('ws');

const wss = new WebSocketServer({ port: 8080 });

const MAX_PLAYERS = 6;
const MAX_BOXES = 15;
const MAX_PLATES = 10;
const SPAWN_INTERVAL = 2000;
const MIN_BOX_DISTANCE = 5.0;
const BOX_SPEED = 1.5;

const BASE_SPAWNS = {
    1: { x: 24.0, z: 0.0 },
    2: { x: 12.0, z: 20.8 },
    3: { x: -12.0, z: 20.8 },
    4: { x: -24.0, z: 0.0 },
    5: { x: -12.0, z: -20.8 },
    6: { x: 12.0, z: -20.8 }
};

const rooms = new Map();

console.log('Server started on port 8080');

wss.on('connection', (ws) => {
    ws.id = Math.random().toString(36).substring(2, 9);
    console.log(`New client connected: ${ws.id}`);
    
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            handleMessage(ws, message);
        } catch (e) {
            console.error('Invalid message format', e);
        }
    });

    ws.on('close', () => {
        console.log(`Client ${ws.id} disconnected`);
        leaveRoom(ws);
    });
});

function handleMessage(ws, message) {
    switch (message.type) {
        case 'join_random':
            joinRandomRoom(ws);
            break;
        case 'update_position':
            broadcastToRoom(ws, { 
                type: 'player_moved', 
                id: ws.id, 
                pos: message.pos, 
                rot: message.rot,
                anim: message.anim,
                anim_speed: message.anim_speed
            });
            break;
        case 'send_message':
            broadcastToRoom(ws, { type: 'message', content: message.content, senderId: ws.id });
            break;
        case 'collect_box':
            handleBoxCollection(ws, message.box_id);
            break;
        default:
            console.log('Unknown message type:', message.type);
    }
}

function handleBoxCollection(ws, boxId) {
    if (ws.roomId && rooms.has(ws.roomId)) {
        const room = rooms.get(ws.roomId);
        if (room.boxes.has(boxId)) {
            const baseId = room.bases.get(ws.id);
            
            // Check capacity
            let count = 0;
            const plates = room.basePlates.get(baseId);
            if (plates) {
                for (let i = 0; i < MAX_PLATES; i++) {
                    if (plates[i] !== null) count++;
                }
            }
            for (const box of room.boxes.values()) {
                if (box.isMoving && box.ownerId !== null && room.bases.get(box.ownerId) === baseId) {
                    count++;
                }
            }
            
            if (count >= MAX_PLATES) {
                ws.send(JSON.stringify({ type: 'collection_failed', box_id: boxId }));
                return; // Base is full
            }

            const target = BASE_SPAWNS[baseId];
            if (target) {
                const box = room.boxes.get(boxId);
                box.isMoving = true;
                box.ownerId = ws.id;
                box.targetX = target.x;
                box.targetZ = target.z;
                
                broadcastToRoom(null, { type: 'box_collected', box_id: boxId, owner_id: ws.id }, ws.roomId);
            }
        }
    }
}

function startBoxSpawner(roomId) {
    const room = rooms.get(roomId);
    if (!room || room.interval) return;

    room.interval = setInterval(() => {
        if (room.boxes.size >= MAX_BOXES) return;

        let bestCandidate = null;
        let maxMinDist = -1;
        const numCandidates = 20; 
        
        for (let i = 0; i < numCandidates; i++) {
            const angle = Math.random() * Math.PI * 2;
            const r = Math.sqrt(Math.random()) * 13;
            const x = Math.cos(angle) * r;
            const z = Math.sin(angle) * r;

            let minDist = Infinity;
            if (room.boxes.size === 0) {
                minDist = 100;
            } else {
                for (const box of room.boxes.values()) {
                    const d = Math.sqrt((x - box.x) ** 2 + (z - box.z) ** 2);
                    if (d < minDist) minDist = d;
                }
            }

            if (minDist > maxMinDist) {
                maxMinDist = minDist;
                bestCandidate = { x, z };
            }
        }

        if (bestCandidate && (room.boxes.size === 0 || maxMinDist >= MIN_BOX_DISTANCE)) {
            const boxId = Math.random().toString(36).substring(2, 7);
            const rotY = Math.random() * Math.PI * 2;
            const boxData = { 
                id: boxId, 
                x: bestCandidate.x, 
                z: bestCandidate.z, 
                rotY, 
                isMoving: false,
                ownerId: null,
                originalX: bestCandidate.x,
                originalZ: bestCandidate.z
            };
            room.boxes.set(boxId, boxData);

            broadcastToRoom(null, { type: 'box_spawned', box: boxData }, roomId);
        }
    }, SPAWN_INTERVAL);
}

function startPhysicsLoop(roomId) {
    const room = rooms.get(roomId);
    if (!room || room.physicsInterval) return;

    room.physicsInterval = setInterval(() => {
        let movedBoxes = [];
        for (const box of room.boxes.values()) {
            if (box.isMoving) {
                const dx = box.targetX - box.x;
                const dz = box.targetZ - box.z;
                const dist = Math.sqrt(dx * dx + dz * dz);
                
                if (dist < 0.5) {
                    if (box.ownerId !== null) {
                        // Reached player target - assign to plate
                        const baseId = room.bases.get(box.ownerId);
                        const plates = room.basePlates.get(baseId);
                        
                        let freePlateIdx = -1;
                        for(let i = 0; i < MAX_PLATES; i++) {
                            if (plates[i] === null) {
                                freePlateIdx = i;
                                break;
                            }
                        }
                        
                        room.boxes.delete(box.id);
                        
                        if (freePlateIdx !== -1) {
                            plates[freePlateIdx] = { id: box.id };
                            broadcastToRoom(null, { 
                                type: 'box_plated', 
                                box_id: box.id, 
                                base_id: baseId, 
                                plate_id: freePlateIdx + 1 
                            }, roomId);
                        } else {
                            // Base is full, remove box
                            broadcastToRoom(null, { type: 'box_removed', box_id: box.id }, roomId);
                        }
                    } else {
                        // Returned to original point - stop moving
                        box.isMoving = false;
                        box.x = box.targetX;
                        box.z = box.targetZ;
                        movedBoxes.push({ id: box.id, x: box.x, z: box.z, rotY: box.rotY });
                    }
                } else {
                    const speed = BOX_SPEED;
                    const dt = 0.05; // 50ms interval = 20 fps
                    const moveDist = Math.min(dist, speed * dt);
                    
                    box.x += (dx / dist) * moveDist;
                    box.z += (dz / dist) * moveDist;
                    box.rotY = Math.atan2(dx, dz);
                    
                    movedBoxes.push({ id: box.id, x: box.x, z: box.z, rotY: box.rotY });
                }
            }
        }
        
        if (movedBoxes.length > 0) {
            broadcastToRoom(null, { type: 'boxes_moved', boxes: movedBoxes }, roomId);
        }
    }, 50);
}

function joinRandomRoom(ws) {
    leaveRoom(ws);

    let roomId = null;
    for (const [id, room] of rooms.entries()) {
        if (room.players.size < room.max) {
            roomId = id;
            break;
        }
    }

    if (!roomId) {
        roomId = Math.random().toString(36).substring(2, 9);
        const newRoom = { 
            players: new Set(), 
            bases: new Map(), 
            boxes: new Map(),
            basePlates: new Map(),
            max: MAX_PLAYERS,
            interval: null,
            physicsInterval: null
        };
        for(let i=1; i<=MAX_PLAYERS; i++) {
            newRoom.basePlates.set(i, new Array(MAX_PLATES).fill(null));
        }
        rooms.set(roomId, newRoom);
        
        startBoxSpawner(roomId);
        startPhysicsLoop(roomId);
    }

    const room = rooms.get(roomId);
    
    // Find free base
    let assignedBase = 1;
    let usedBases = new Set(room.bases.values());
    for (let i = 1; i <= MAX_PLAYERS; i++) {
        if (!usedBases.has(i)) {
            assignedBase = i;
            break;
        }
    }
    room.bases.set(ws.id, assignedBase);
    
    const joinMsg = JSON.stringify({ type: 'player_joined', id: ws.id, base: assignedBase });
    room.players.forEach(player => {
        player.send(joinMsg);
    });

    const existingPlayers = Array.from(room.players).map(p => ({ id: p.id, base: room.bases.get(p.id) }));
    const currentBoxes = Array.from(room.boxes.values());
    
    const currentPlatedBoxes = [];
    for (const [bId, plates] of room.basePlates.entries()) {
        for (let i = 0; i < MAX_PLATES; i++) {
            if (plates[i] !== null) {
                currentPlatedBoxes.push({ box_id: plates[i].id, base_id: bId, plate_id: i + 1 });
            }
        }
    }
    
    room.players.add(ws);
    ws.roomId = roomId;

    console.log(`Client ${ws.id} joined room: ${roomId} at base ${assignedBase}`);
    ws.send(JSON.stringify({ 
        type: 'joined', 
        room_id: roomId, 
        self_id: ws.id,
        base: assignedBase,
        players: existingPlayers,
        boxes: currentBoxes,
        plated_boxes: currentPlatedBoxes
    }));
}

function leaveRoom(ws) {
    if (ws.roomId && rooms.has(ws.roomId)) {
        const room = rooms.get(ws.roomId);
        const baseId = room.bases.get(ws.id);
        
        room.players.delete(ws);
        room.bases.delete(ws.id);
        
        // Reset any moving boxes owned by this player
        for (const box of room.boxes.values()) {
            if (box.ownerId === ws.id) {
                box.ownerId = null;
                box.targetX = box.originalX;
                box.targetZ = box.originalZ;
                broadcastToRoom(null, { type: 'box_collected', box_id: box.id, owner_id: null }, ws.roomId);
            }
        }
        
        // Remove plated boxes
        if (baseId) {
            const plates = room.basePlates.get(baseId);
            if (plates) {
                for(let i = 0; i < MAX_PLATES; i++) {
                    if (plates[i] !== null) {
                        broadcastToRoom(null, { type: 'box_removed', box_id: plates[i].id }, ws.roomId);
                        plates[i] = null;
                    }
                }
            }
        }
        
        broadcastToRoom(ws, { type: 'player_left', id: ws.id });

        if (room.players.size === 0) {
            if (room.interval) clearInterval(room.interval);
            if (room.physicsInterval) clearInterval(room.physicsInterval);
            rooms.delete(ws.roomId);
        }
        delete ws.roomId;
    }
}

function broadcastToRoom(ws, data, targetRoomId = null) {
    const roomId = targetRoomId || (ws ? ws.roomId : null);
    if (roomId && rooms.has(roomId)) {
        const room = rooms.get(roomId);
        const json = JSON.stringify(data);
        room.players.forEach(player => {
            if (player !== ws && player.readyState === 1) {
                player.send(json);
            }
        });
    }
}
