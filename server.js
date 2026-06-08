let DataSocket = require("fyers-api-v3").fyersDataSocket;
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');

// Railway (and most hosts) assign the public port via the PORT env var.
const PORT = process.env.PORT || 9000;

// A tiny HTTP server gives the public URL a health response AND lets the
// WebSocket server share the single port the host exposes.
const httpServer = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Fyers WebSocket bridge is running\n");
});

// Attach the WebSocket server to the HTTP server (same port).
const localWss = new WebSocket.Server({ server: httpServer });

// Endpoint that returns { "access_token": "...", "api_id": "APPID-100" }
const TOKEN_URL = "https://trade.zyfoxe.com/fyers-token";
const logPath = "./logs"; // Path must exist
fs.mkdirSync(logPath, { recursive: true });

// Holds the Fyers data socket once it's connected
let skt = null;

// Fetch the latest access token + app id and build the "APPID:JWT" string the SDK expects
async function fetchAccessToken() {
    const res = await fetch(TOKEN_URL);
    if (!res.ok) {
        throw new Error(`Token endpoint returned HTTP ${res.status}`);
    }
    const data = await res.json();
    const appId = data.api_id || data.app_id;
    const token = data.access_token;
    if (!appId || !token) {
        throw new Error(`Unexpected token response: ${JSON.stringify(data)}`);
    }
    return `${appId}:${token}`;
}

async function start() {
    const accessToken = await fetchAccessToken();
    console.log("Fetched access token, connecting to Fyers...");

    skt = new DataSocket(accessToken, logPath, true);

    skt.on("connect", function () {
        // skt.mode(skt.LiteMode)
        // to revert back to full mode
        skt.mode(skt.FullMode);
    });

    skt.on("message", function (message) {
        console.log(message);
        localWss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(message));
            }
        });
    });

    skt.on("error", function (message) {
        console.log("erroris", message);
    });

    skt.on("close", function () {
        console.log("socket closed");
    });

    // --- CRITICAL: Start the connection ---
    skt.connect();
}

// 1. Listen for a new connection from your website
localWss.on('connection', function (browserClient) {
    console.log("New browser window connected");

    // 2. Now listen for messages from THIS specific browser client
    browserClient.on('message', function (message) {
        console.log("Received raw data:", message.toString());

        try {
            // In Node.js, message might arrive as a Buffer, so use .toString()
            const command = JSON.parse(message.toString());
            console.log("Parsed Command:", command);

            if (!skt) {
                browserClient.send(JSON.stringify({
                    status: "Error",
                    msg: "Fyers socket not connected yet"
                }));
                return;
            }

            if (command.action === 'subscribe') {
                // Call your Fyers Data Socket (skt)
                skt.subscribe(command.symbols);
                console.log(command.symbols);

                // Send confirmation back to the website
                browserClient.send(JSON.stringify({
                    status: "Success",
                    msg: `Subscribed to ${command.symbols}`
                }));
            }

            if (command.action === 'change_mode') {
                // Ensure skt is your Fyers instance
                skt.mode(command.mode === 'lite' ? skt.LiteMode : skt.FullMode);
                console.log("Mode changed to:", command.mode);
            }
        } catch (e) {
            console.error("Invalid JSON or error in command:", e.message);
        }
    });
});

httpServer.listen(PORT, () => {
    console.log(`WebSocket bridge listening on port ${PORT}`);
});

start().catch(err => {
    console.error("Failed to start:", err.message);
    process.exit(1);
});
