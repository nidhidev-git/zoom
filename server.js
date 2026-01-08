const https = require('https');
const fs = require('fs');
const express = require('express');
const socketIo = require('socket.io');
const mediasoup = require('mediasoup');
const config = require('./config');
const path = require('path');

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

const app = express();
let httpsServer;

// Check if we are checking for certs or just falling back to http (Render handles SSL termination)
// Or simply check if file exists
if (fs.existsSync(config.sslKey) && fs.existsSync(config.sslCrt)) {
    const options = {
        key: fs.readFileSync(config.sslKey),
        cert: fs.readFileSync(config.sslCrt),
    };
    httpsServer = https.createServer(options, app);
    console.log('Using HTTPS with local certificates.');
} else {
    // Fallback to HTTP (Production / Render)
    const http = require('http');
    httpsServer = http.createServer(app);
    console.log('SSL certificates not found. Using HTTP (likely behind reverse proxy/Render).');
}

const io = socketIo(httpsServer);

app.use(express.static('public'));

let worker;

// Map RoomId -> { router, peers: Map<socketId, { id, name, isHost, canProduce }> }
const rooms = new Map();

// Global map to store producers for cleanup/lookup
const producers = new Map();

(async () => {
    try {
        await runMediasoupWorker();
    } catch (err) {
        console.error(err);
    }
})();

async function runMediasoupWorker() {
    worker = await mediasoup.createWorker({
        logLevel: config.mediasoup.worker.logLevel,
        logTags: config.mediasoup.worker.logTags,
        rtcMinPort: config.mediasoup.worker.rtcMinPort,
        rtcMaxPort: config.mediasoup.worker.rtcMaxPort,
    });

    worker.on('died', () => {
        console.error('mediasoup worker died, exiting in 2 seconds... [pid:%d]', worker.pid);
        setTimeout(() => process.exit(1), 2000);
    });

    console.log('Mediasoup Worker created');
}

async function getOrCreateRouter(roomId) {
    if (rooms.has(roomId)) {
        return rooms.get(roomId).router;
    }

    const mediaCodecs = config.mediasoup.router.mediaCodecs;
    const router = await worker.createRouter({ mediaCodecs });

    rooms.set(roomId, {
        router,
        peers: new Map()
    });
    console.log(`Created new router for room: ${roomId}`);
    return router;
}

io.on('connection', (socket) => {
    console.log('client connected:', socket.id);

    socket.data = {
        roomId: null,
        name: null,
        isHost: false,
        canProduce: false,
        producerTransport: null,
        consumerTransport: null,
        producers: new Map(),
        consumers: new Map(),
    };

    socket.on('joinRoom', async ({ roomId, name }, callback) => {
        try {
            const router = await getOrCreateRouter(roomId);
            socket.join(roomId);
            socket.data.roomId = roomId;
            socket.data.name = name;

            const room = rooms.get(roomId);

            // Determine Role
            const isFirstUser = room.peers.size === 0;
            if (isFirstUser) {
                socket.data.isHost = true;
                socket.data.canProduce = true;
            } else {
                socket.data.isHost = false;
                socket.data.canProduce = false;
            }

            const peerInfo = {
                id: socket.id,
                name: name,
                isHost: socket.data.isHost,
                canProduce: socket.data.canProduce
            };

            room.peers.set(socket.id, peerInfo);

            console.log(`Socket ${socket.id} (${name}) joined room ${roomId}. Host: ${socket.data.isHost}`);

            // Send existing producers
            const existingProducers = [];
            for (const [pid, pData] of producers) {
                if (pData.roomId === roomId && pData.socketId !== socket.id) {
                    existingProducers.push(pid);
                }
            }

            callback({
                rtpCapabilities: router.rtpCapabilities,
                existingProducers,
                checkRole: { isHost: socket.data.isHost, canProduce: socket.data.canProduce }
            });

            broadcastParticipants(roomId);

        } catch (err) {
            console.error(err);
            callback({ error: err.message });
        }
    });

    function broadcastParticipants(roomId) {
        if (rooms.has(roomId)) {
            const participantList = Array.from(rooms.get(roomId).peers.values());
            io.to(roomId).emit('updateParticipants', participantList);
        }
    }

    socket.on('promoteToProducer', ({ targetSocketId }) => {
        const { roomId, isHost } = socket.data;
        if (!isHost) return;

        const room = rooms.get(roomId);
        if (room && room.peers.has(targetSocketId)) {
            room.peers.get(targetSocketId).canProduce = true;
            io.to(targetSocketId).emit('permissionGranted', { canProduce: true });

            const targetSocket = io.sockets.sockets.get(targetSocketId);
            if (targetSocket) targetSocket.data.canProduce = true;

            broadcastParticipants(roomId);
        }
    });

    socket.on('producerClose', ({ producerId }) => {
        if (producers.has(producerId)) {
            const pData = producers.get(producerId);
            if (pData.socketId === socket.id) {
                pData.producer.close();
                producers.delete(producerId);
                socket.data.producers.delete(producerId);

                if (socket.data.roomId) {
                    socket.to(socket.data.roomId).emit('producerClosed', { producerId });
                }
            }
        }
    });

    socket.on('forceStopProducer', ({ producerId }) => {
        const { roomId, isHost } = socket.data;
        if (!isHost) return;

        if (producers.has(producerId)) {
            const pData = producers.get(producerId);
            if (pData.roomId === roomId) {
                pData.producer.close();
                producers.delete(producerId);

                io.to(pData.socketId).emit('producerForcedStop', { producerId });
                io.to(roomId).emit('producerClosed', { producerId });

                const ownerSocket = io.sockets.sockets.get(pData.socketId);
                if (ownerSocket) {
                    ownerSocket.data.producers.delete(producerId);
                }
            }
        }
    });

    socket.on('disconnect', () => {
        console.log('client disconnected:', socket.id);
        const { roomId } = socket.data;

        for (const producer of socket.data.producers.values()) {
            producer.close();
            producers.delete(producer.id);
            if (roomId) {
                socket.to(roomId).emit('producerClosed', { producerId: producer.id });
            }
        }

        for (const consumer of socket.data.consumers.values()) {
            consumer.close();
        }

        if (roomId && rooms.has(roomId)) {
            rooms.get(roomId).peers.delete(socket.id);
            broadcastParticipants(roomId);
        }
    });

    // ... Transports ...
    socket.on('createProducerTransport', async ({ forceTcp, rtpCapabilities }, callback) => {
        try {
            const { roomId } = socket.data;
            if (!rooms.has(roomId)) throw new Error('Not in a room');
            const router = rooms.get(roomId).router;
            const { transport, params } = await createWebRtcTransport(router);
            socket.data.producerTransport = transport;
            callback(params);
        } catch (err) { console.error(err); callback({ error: err.message }); }
    });

    socket.on('createConsumerTransport', async ({ forceTcp, rtpCapabilities }, callback) => {
        try {
            const { roomId } = socket.data;
            if (!rooms.has(roomId)) throw new Error('Not in a room');
            const router = rooms.get(roomId).router;
            const { transport, params } = await createWebRtcTransport(router);
            socket.data.consumerTransport = transport;
            callback(params);
        } catch (err) { console.error(err); callback({ error: err.message }); }
    });

    socket.on('connectProducerTransport', async ({ dtlsParameters }, callback) => {
        if (socket.data.producerTransport) await socket.data.producerTransport.connect({ dtlsParameters });
        callback();
    });

    socket.on('connectConsumerTransport', async ({ dtlsParameters }, callback) => {
        if (socket.data.consumerTransport) await socket.data.consumerTransport.connect({ dtlsParameters });
        callback();
    });

    // UPDATED: Pass appData
    socket.on('produce', async ({ kind, rtpParameters, appData }, callback) => {
        try {
            if (!socket.data.canProduce) throw new Error('Permission Denied');
            if (!socket.data.producerTransport) throw new Error('No carrier');

            const producer = await socket.data.producerTransport.produce({ kind, rtpParameters, appData });
            socket.data.producers.set(producer.id, producer);
            const roomId = socket.data.roomId;
            producers.set(producer.id, { producer, socketId: socket.id, roomId });

            producer.on('transportclose', () => {
                producer.close();
                producers.delete(producer.id);
                socket.data.producers.delete(producer.id);
            });

            callback({ id: producer.id });
            socket.to(roomId).emit('newProducer', { producerId: producer.id });
        } catch (err) { console.error('Produce error', err); callback({ error: err.message }); }
    });

    // UPDATED: Pass appData back to consumer
    socket.on('consume', async ({ producerId, rtpCapabilities }, callback) => {
        try {
            const { roomId } = socket.data;
            if (!roomId) throw new Error('No Room');
            const router = rooms.get(roomId).router;

            if (!router.canConsume({ producerId, rtpCapabilities })) {
                callback({ error: 'Cannot consume' });
                return;
            }

            const consumer = await socket.data.consumerTransport.consume({
                producerId, rtpCapabilities, paused: true,
            });

            socket.data.consumers.set(consumer.id, consumer);

            consumer.on('transportclose', () => socket.data.consumers.delete(consumer.id));
            consumer.on('producerclose', () => {
                socket.emit('producerClosed', { producerId });
                consumer.close();
                socket.data.consumers.delete(consumer.id);
            });

            // Fetch Producer appData
            const producerData = producers.get(producerId);
            const appData = producerData ? producerData.producer.appData : {};

            callback({
                id: consumer.id, producerId, kind: consumer.kind, rtpParameters: consumer.rtpParameters, appData
            });
        } catch (error) { console.error('consume failed', error); callback({ error: error.message }); }
    });

    socket.on('resume', async ({ consumerId }, callback) => {
        if (consumerId && socket.data.consumers.has(consumerId)) {
            await socket.data.consumers.get(consumerId).resume();
        }
        callback();
    });
});

async function createWebRtcTransport(router) {
    const {
        maxIncomingBitrate,
        initialAvailableOutgoingBitrate,
        listenIps
    } = config.mediasoup.webRtcTransport;

    const transport = await router.createWebRtcTransport({
        listenIps, enableUdp: true, enableTcp: true, preferUdp: true, initialAvailableOutgoingBitrate,
    });

    if (maxIncomingBitrate) {
        try { await transport.setMaxIncomingBitrate(maxIncomingBitrate); } catch (e) { }
    }

    return {
        transport,
        params: {
            id: transport.id, iceParameters: transport.iceParameters, iceCandidates: transport.iceCandidates, dtlsParameters: transport.dtlsParameters,
        },
    };
}

httpsServer.listen(config.listenPort, () => {
    const proto = (fs.existsSync(config.sslKey) && fs.existsSync(config.sslCrt)) ? 'https' : 'http';
    console.log(`Listening on ${proto}://${config.listenIp}:${config.listenPort}`);
});
