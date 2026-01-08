const os = require('os');
const path = require('path');
require('dotenv').config();

module.exports = {
    listenIp: '0.0.0.0',
    listenPort: process.env.PORT || 3000,
    sslCrt: path.join(__dirname, 'certs/cert.pem'),
    sslKey: path.join(__dirname, 'certs/key.pem'),

    mediasoup: {
        // Worker settings
        numWorkers: Object.keys(os.cpus()).length,
        worker: {
            rtcMinPort: Number(process.env.RTC_MIN_PORT) || 20000,
            rtcMaxPort: Number(process.env.RTC_MAX_PORT) || 20100,
            logLevel: 'warn',
            logTags: [
                'info',
                'ice',
                'dtls',
                'rtp',
                'srtp',
                'rtcp',
                // 'rtx',
                // 'bwe',
                // 'score',
                // 'simulcast',
                // 'svc',
                // 'sctp',
            ],
        },
        // Router settings
        router: {
            mediaCodecs: [
                {
                    kind: 'audio',
                    mimeType: 'audio/opus',
                    clockRate: 48000,
                    channels: 2
                },
                {
                    kind: 'video',
                    mimeType: 'video/VP8',
                    clockRate: 90000,
                    parameters:
                    {
                        'x-google-start-bitrate': 1000
                    }
                },
            ]
        },
        // Transport settings
        webRtcTransport: {
            listenIps: [
                {
                    ip: '0.0.0.0', // Transports will listen on all interfaces
                    announcedIp: '210.79.128.191' // ANNOUNCE THIS IP TO CLIENTS.
                }
            ],
            initialAvailableOutgoingBitrate: 1000000,
            minimumAvailableOutgoingBitrate: 600000,
            maxSctpMessageSize: 262144,
            // Additional options that might helps
            maxIncomingBitrate: 1500000
        }
    }
};
