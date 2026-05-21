const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

const MAX_PLAYERS = 6;
const MAX_BOXES = 15;
const MAX_PLATES = 8;
const SPAWN_INTERVAL = 2000;
const MIN_BOX_DISTANCE = 5.0;
const BOX_SPEED = 2.5;

const BOX_CONFIG = [
    { name: "Noobini Pizzanini", price: 25, income: 1, rarity: 0 },
    { name: "Tim Cheese", price: 500, income: 5, rarity: 0 },
    { name: "Pipi Kiwi", price: 1500, income: 13, rarity: 1 },
    { name: "Trippi Troppi", price: 2000, income: 15, rarity: 1 }
];

const BASE_SPAWNS = {
    1: { x: 24.0, z: 0.0 },
    2: { x: 12.0, z: 20.8 },
    3: { x: -12.0, z: 20.8 },
    4: { x: -24.0, z: 0.0 },
    5: { x: -12.0, z: -20.8 },
    6: { x: 12.0, z: -20.8 }
};

const rooms = new Map();

console.log(`Server started on port ${PORT}`);

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
            if (ws.roomId && rooms.has(ws.roomId)) {
                const room = rooms.get(ws.roomId);
                room.playerStates.set(ws.id, {
                    id: ws.id,
                    pos: message.pos,
                    rot: message.rot,
                    anim: message.anim,
                    anim_speed: message.anim_speed
                });
            }
            break;
        case 'send_message':
            broadcastToRoom(ws, { type: 'message', content: message.content, senderId: ws.id });
            break;
        case 'collect_box':
            handleBoxCollection(ws, message.box_id);
            break;
        case 'collect_income':
            if (ws.roomId && rooms.has(ws.roomId)) {
                const room = rooms.get(ws.roomId);
                const baseId = room.bases.get(ws.id);
                const plateIdx = message.plate_index - 1; // 0-based
                
                if (baseId && plateIdx >= 0 && plateIdx < MAX_PLATES) {
                    const uncollectedPlates = room.uncollectedPlates.get(baseId);
                    if (uncollectedPlates && uncollectedPlates[plateIdx] > 0) {
                        const amount = uncollectedPlates[plateIdx];
                        const currentBalance = room.balances.get(ws.id) || 0;
                        const newBalance = currentBalance + amount;
                        
                        room.balances.set(ws.id, newBalance);
                        uncollectedPlates[plateIdx] = 0;
                        
                        ws.send(JSON.stringify({ type: 'update_balance', balance: newBalance }));
                        ws.send(JSON.stringify({ type: 'update_uncollected_plate', plate_index: message.plate_index, amount: 0 }));
                    }
                }
            }
            break;
        case 'sell_box':
            handleSellBox(ws, message.box_id);
            break;
        case 'take_box':
            handleTakeBox(ws, message.box_id);
            break;
        case 'steal_box':
            handleStealBox(ws, message.box_id);
            break;
        case 'auto_place_box':
            handleAutoPlaceBox(ws);
            break;
        case 'place_box':
            handlePlaceBox(ws, message.plate_id);
            break;
        default:
            console.log('Unknown message type:', message.type);
    }
}

function handleSellBox(ws, boxId) {
    if (ws.roomId && rooms.has(ws.roomId)) {
        const room = rooms.get(ws.roomId);
        const baseId = room.bases.get(ws.id);
        if (!baseId) return;

        const plates = room.basePlates.get(baseId);
        if (!plates) return;

        let plateIdx = -1;
        let boxType = null;
        for (let i = 0; i < MAX_PLATES; i++) {
            if (plates[i] && plates[i].id === boxId) {
                plateIdx = i;
                boxType = plates[i].type;
                break;
            }
        }

        if (plateIdx !== -1 && boxType !== null) {
            const boxPrice = BOX_CONFIG[boxType].price;
            const sellValue = Math.floor(boxPrice * 0.7);

            const uncollectedPlates = room.uncollectedPlates.get(baseId);
            let uncollectedAmount = 0;
            if (uncollectedPlates && uncollectedPlates[plateIdx] > 0) {
                uncollectedAmount = uncollectedPlates[plateIdx];
                uncollectedPlates[plateIdx] = 0;
            }

            const currentBalance = room.balances.get(ws.id) || 0;
            const newBalance = currentBalance + sellValue + uncollectedAmount;

            room.balances.set(ws.id, newBalance);

            ws.send(JSON.stringify({ type: 'update_balance', balance: newBalance }));
            ws.send(JSON.stringify({ type: 'update_uncollected_plate', plate_index: plateIdx + 1, amount: 0 }));

            plates[plateIdx] = null;
            broadcastToRoom(null, { type: 'box_removed', box_id: boxId }, ws.roomId);
        }
    }
}

function handleTakeBox(ws, boxId) {
    if (ws.roomId && rooms.has(ws.roomId)) {
        const room = rooms.get(ws.roomId);
        const baseId = room.bases.get(ws.id);
        if (!baseId) return;

        const plates = room.basePlates.get(baseId);
        if (!plates) return;

        let plateIdx = -1;
        let targetBoxData = null;
        for (let i = 0; i < MAX_PLATES; i++) {
            if (plates[i] && plates[i].id === boxId) {
                plateIdx = i;
                targetBoxData = plates[i];
                break;
            }
        }

        if (plateIdx !== -1 && targetBoxData !== null) {
            const uncollectedPlates = room.uncollectedPlates.get(baseId);
            let targetUncollectedAmount = 0;
            if (uncollectedPlates && uncollectedPlates[plateIdx] > 0) {
                targetUncollectedAmount = uncollectedPlates[plateIdx];
            }

            const held = room.heldBoxes.get(ws.id);
            if (held) {
                plates[plateIdx] = held.box;
                if (uncollectedPlates) uncollectedPlates[plateIdx] = held.balance;
                
                room.heldBoxes.set(ws.id, { box: targetBoxData, balance: targetUncollectedAmount });

                broadcastToRoom(null, { 
                    type: 'box_plated', 
                    box_id: held.box.id, 
                    box_type: held.box.type,
                    base_id: baseId, 
                    plate_id: plateIdx + 1,
                    instant: true
                }, ws.roomId);
                
                broadcastToRoom(null, { type: 'box_grabbed', box_id: targetBoxData.id, player_id: ws.id }, ws.roomId);
                
                ws.send(JSON.stringify({ type: 'update_uncollected_plate', plate_index: plateIdx + 1, amount: held.balance }));
            } else {
                plates[plateIdx] = null;
                if (uncollectedPlates) uncollectedPlates[plateIdx] = 0;
                
                room.heldBoxes.set(ws.id, { box: targetBoxData, balance: targetUncollectedAmount });
                
                broadcastToRoom(null, { type: 'box_grabbed', box_id: targetBoxData.id, player_id: ws.id }, ws.roomId);
                
                ws.send(JSON.stringify({ type: 'update_uncollected_plate', plate_index: plateIdx + 1, amount: 0 }));
            }
        }
    }
}

function handlePlaceBox(ws, plateId) {
    if (ws.roomId && rooms.has(ws.roomId)) {
        const room = rooms.get(ws.roomId);
        const baseId = room.bases.get(ws.id);
        if (!baseId) return;

        const held = room.heldBoxes.get(ws.id);
        if (!held) return;

        const plates = room.basePlates.get(baseId);
        if (!plates) return;
        
        const plateIdx = plateId - 1;
        if (plateIdx < 0 || plateIdx >= MAX_PLATES) return;

        if (plates[plateIdx] === null) {
            plates[plateIdx] = held.box;
            const uncollectedPlates = room.uncollectedPlates.get(baseId);
            if (uncollectedPlates) {
                uncollectedPlates[plateIdx] = held.balance;
            }

            room.heldBoxes.delete(ws.id);

            broadcastToRoom(null, { 
                type: 'box_plated', 
                box_id: held.box.id, 
                box_type: held.box.type,
                base_id: baseId, 
                plate_id: plateId,
                instant: true
            }, ws.roomId);
            
            broadcastToRoom(null, { type: 'box_dropped', player_id: ws.id }, ws.roomId);
            
            ws.send(JSON.stringify({ type: 'update_uncollected_plate', plate_index: plateId, amount: held.balance }));
        }
    }
}

function handleStealBox(ws, boxId) {
    if (ws.roomId && rooms.has(ws.roomId)) {
        const room = rooms.get(ws.roomId);
        const myBaseId = room.bases.get(ws.id);
        if (!myBaseId) return;

        // Check if I already hold a box
        if (room.heldBoxes.has(ws.id)) return;

        // Check capacity
        let count = 0;
        const myPlates = room.basePlates.get(myBaseId);
        if (myPlates) {
            for (let i = 0; i < MAX_PLATES; i++) {
                if (myPlates[i] !== null) count++;
            }
        }
        for (const box of room.boxes.values()) {
            if (box.isMoving && box.ownerId !== null && room.bases.get(box.ownerId) === myBaseId) {
                count++;
            }
        }
        for (const [playerId, held] of room.heldBoxes.entries()) {
            if (room.bases.get(playerId) === myBaseId) {
                count++;
            }
        }
        if (count >= MAX_PLATES) return; // Base is full

        // Find the box in any base EXCEPT mine
        let victimBaseId = -1;
        let plateIdx = -1;
        let targetBoxData = null;

        for (const [bId, plates] of room.basePlates.entries()) {
            if (bId === myBaseId) continue;
            for (let i = 0; i < MAX_PLATES; i++) {
                if (plates[i] && plates[i].id === boxId) {
                    victimBaseId = bId;
                    plateIdx = i;
                    targetBoxData = plates[i];
                    break;
                }
            }
            if (victimBaseId !== -1) break;
        }

        if (plateIdx !== -1 && targetBoxData !== null) {
            // Remove from victim's plate
            const plates = room.basePlates.get(victimBaseId);
            plates[plateIdx] = null;
            
            const uncollectedPlates = room.uncollectedPlates.get(victimBaseId);
            let targetUncollectedAmount = 0;
            if (uncollectedPlates && uncollectedPlates[plateIdx] > 0) {
                targetUncollectedAmount = uncollectedPlates[plateIdx];
                uncollectedPlates[plateIdx] = 0;
            }

            // Tell the victim their box is gone and uncollected is 0
            let victimWs = null;
            for (const player of room.players) {
                if (room.bases.get(player.id) === victimBaseId) {
                    victimWs = player;
                    break;
                }
            }
            if (victimWs && victimWs.readyState === 1) {
                victimWs.send(JSON.stringify({ type: 'update_uncollected_plate', plate_index: plateIdx + 1, amount: 0 }));
            }

            // Stealer holds it now
            room.heldBoxes.set(ws.id, { box: targetBoxData, balance: targetUncollectedAmount });
            
            // Broadcast grab event to show box over head
            broadcastToRoom(null, { type: 'box_grabbed', box_id: targetBoxData.id, player_id: ws.id }, ws.roomId);
        }
    }
}

function handleAutoPlaceBox(ws) {
    if (ws.roomId && rooms.has(ws.roomId)) {
        const room = rooms.get(ws.roomId);
        const baseId = room.bases.get(ws.id);
        if (!baseId) return;

        const held = room.heldBoxes.get(ws.id);
        if (!held) return; // Player is not holding anything

        const plates = room.basePlates.get(baseId);
        if (!plates) return;
        
        // Find a free plate
        let plateIdx = -1;
        for (let i = 0; i < MAX_PLATES; i++) {
            if (plates[i] === null) {
                plateIdx = i;
                break;
            }
        }

        if (plateIdx !== -1) {
            plates[plateIdx] = held.box;
            const uncollectedPlates = room.uncollectedPlates.get(baseId);
            if (uncollectedPlates) {
                uncollectedPlates[plateIdx] = held.balance;
            }

            room.heldBoxes.delete(ws.id);

            broadcastToRoom(null, { 
                type: 'box_plated', 
                box_id: held.box.id, 
                box_type: held.box.type,
                base_id: baseId, 
                plate_id: plateIdx + 1,
                instant: false // Let it slide in or just use true
            }, ws.roomId);
            
            broadcastToRoom(null, { type: 'box_dropped', player_id: ws.id }, ws.roomId);
            
            ws.send(JSON.stringify({ type: 'update_uncollected_plate', plate_index: plateIdx + 1, amount: held.balance }));
        }
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
            for (const [playerId, held] of room.heldBoxes.entries()) {
                if (room.bases.get(playerId) === baseId) {
                    count++;
                }
            }
            
            if (count >= MAX_PLATES) {
                ws.send(JSON.stringify({ type: 'collection_failed', box_id: boxId }));
                return; // Base is full
            }

            const box = room.boxes.get(boxId);
            const boxPrice = BOX_CONFIG[box.type].price;
            const currentBalance = room.balances.get(ws.id) || 0;

            if (currentBalance < boxPrice) {
                ws.send(JSON.stringify({ type: 'collection_failed', box_id: boxId, reason: 'insufficient_funds' }));
                return;
            }

            const target = BASE_SPAWNS[baseId];
            if (target) {
                // Deduct balance
                const newBalance = currentBalance - boxPrice;
                room.balances.set(ws.id, newBalance);
                ws.send(JSON.stringify({ type: 'update_balance', balance: newBalance }));

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
            
            // Count existing boxes by type to maintain balance
            let typeCounts = new Array(BOX_CONFIG.length).fill(0);
            for (const box of room.boxes.values()) {
                typeCounts[box.type]++;
            }

            let boxType = -1;

            // First priority: ensure at least one of each base box (rarity 0) exists
            for (let i = 0; i < BOX_CONFIG.length; i++) {
                if (BOX_CONFIG[i].rarity === 0 && typeCounts[i] === 0) {
                    boxType = i;
                    break;
                }
            }

            if (boxType === -1) {
                // Calculate dynamic weights
                let totalWeight = 0;
                let weights = [];
                for (let i = 0; i < BOX_CONFIG.length; i++) {
                    let rarity = BOX_CONFIG[i].rarity !== undefined ? BOX_CONFIG[i].rarity : 1;
                    
                    // Base weight according to rarity (0 = often, 1 = base, 2 = rare)
                    let baseWeight = 10; 
                    if (rarity === 0) baseWeight = 20;
                    else if (rarity === 1) baseWeight = 10;
                    else if (rarity === 2) baseWeight = 4;
                    else if (rarity > 2) baseWeight = Math.max(1, 4 - (rarity - 2));

                    // Reduce spawn chance proportionally to how many are already on the map
                    let dynamicWeight = baseWeight / (1 + typeCounts[i]);
                    weights.push(dynamicWeight);
                    totalWeight += dynamicWeight;
                }

                // Weighted random
                let rand = Math.random() * totalWeight;
                let cumulative = 0;
                for (let i = 0; i < weights.length; i++) {
                    cumulative += weights[i];
                    if (rand <= cumulative) {
                        boxType = i;
                        break;
                    }
                }
            }
            if (boxType === -1) boxType = 0; // Fallback

            const boxData = { 
                id: boxId, 
                type: boxType,
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
                            plates[freePlateIdx] = { id: box.id, type: box.type };
                            broadcastToRoom(null, { 
                                type: 'box_plated', 
                                box_id: box.id, 
                                box_type: box.type,
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
        
        if (room.playerStates.size > 0) {
            const playersMoved = Array.from(room.playerStates.values());
            broadcastToRoom(null, { type: 'players_moved', players: playersMoved }, roomId);
            room.playerStates.clear();
        }
    }, 50);
}

function startCrushLoop(roomId) {
    const room = rooms.get(roomId);
    if (!room || room.crushInterval) return;

    room.crushInterval = setInterval(() => {
        broadcastToRoom(null, { type: 'crush_plates' }, roomId);
        
        // Calculate income for each plate
        for (const [baseId, plates] of room.basePlates.entries()) {
            const uncollected = room.uncollectedPlates.get(baseId);
            let updatedPlates = [];
            
            for (let i = 0; i < MAX_PLATES; i++) {
                if (plates[i] !== null) {
                    const income = BOX_CONFIG[plates[i].type].income;
                    uncollected[i] += income;
                    updatedPlates.push({ plate_index: i + 1, amount: uncollected[i] });
                }
            }
            
            if (updatedPlates.length > 0) {
                // Find owner of baseId
                let ownerWs = null;
                for (const player of room.players) {
                    if (room.bases.get(player.id) === baseId) {
                        ownerWs = player;
                        break;
                    }
                }
                
                if (ownerWs && ownerWs.readyState === 1) {
                    for (const u of updatedPlates) {
                        ownerWs.send(JSON.stringify({ type: 'update_uncollected_plate', plate_index: u.plate_index, amount: u.amount }));
                    }
                }
            }
        }
        
    }, 1000); // 1 second interval for the crush animation
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
            heldBoxes: new Map(),
            balances: new Map(),
            uncollectedPlates: new Map(),
            playerStates: new Map(),
            max: MAX_PLAYERS,
            interval: null,
            physicsInterval: null,
            crushInterval: null
        };
        for(let i=1; i<=MAX_PLAYERS; i++) {
            newRoom.basePlates.set(i, new Array(MAX_PLATES).fill(null));
            newRoom.uncollectedPlates.set(i, new Array(MAX_PLATES).fill(0));
        }
        rooms.set(roomId, newRoom);
        
        startBoxSpawner(roomId);
        startPhysicsLoop(roomId);
        startCrushLoop(roomId);
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

    if (!room.balances.has(ws.id)) {
        room.balances.set(ws.id, 100);
    }
    const startBalance = room.balances.get(ws.id);
    const startUncollectedPlates = room.uncollectedPlates.get(assignedBase) || new Array(MAX_PLATES).fill(0);

    console.log(`Client ${ws.id} joined room: ${roomId} at base ${assignedBase}`);
    ws.send(JSON.stringify({ 
        type: 'joined', 
        room_id: roomId, 
        self_id: ws.id,
        base: assignedBase,
        balance: startBalance,
        box_config: BOX_CONFIG,
        uncollected_plates: startUncollectedPlates,
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
            if (room.crushInterval) clearInterval(room.crushInterval);
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
