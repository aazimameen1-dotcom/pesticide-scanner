require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Telegram Bot Config
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const TG_ENABLED = Boolean(TG_BOT_TOKEN && TG_CHAT_ID);
const TG_API = TG_ENABLED ? `https://api.telegram.org/bot${TG_BOT_TOKEN}` : null;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Serve frontend static files
app.use(express.static(path.join(__dirname, 'public')));

// --- In-memory database backed by Telegram ---
let scans = [];
let nextId = 1;
let lastTelegramSyncAt = null;
let lastTelegramSyncError = null;

function normalizeScan(scan) {
    return {
        id: scan.id,
        package_name: scan.package_name,
        scan_date: scan.scan_date,
        image_path: scan.image_path || null,
        telegram_file_id: scan.telegram_file_id || null,
        ai_description: scan.ai_description || null
    };
}

async function loadFromTelegram() {
    if (!TG_ENABLED) { console.log('Telegram storage is not fully configured, starting with empty DB.'); return; }
    try {
        const chatRes = await fetch(`${TG_API}/getChat?chat_id=${encodeURIComponent(TG_CHAT_ID)}`);
        const chatData = await chatRes.json();
        if (!chatData.ok || !chatData.result.pinned_message || !chatData.result.pinned_message.document) {
            console.log('No data backup found in Telegram, starting fresh.');
            return;
        }
        const doc = chatData.result.pinned_message.document;
        if (doc.file_name !== 'scans.json') {
            console.log('Pinned message is not a data backup, starting fresh.');
            return;
        }
        const fileRes = await fetch(`${TG_API}/getFile?file_id=${encodeURIComponent(doc.file_id)}`);
        const fileData = await fileRes.json();
        if (!fileData.ok || !fileData.result.file_path) return;
        const fileUrl = `https://api.telegram.org/file/bot${TG_BOT_TOKEN}/${fileData.result.file_path}`;
        const dlRes = await fetch(fileUrl);
        const json = await dlRes.json();
        scans = Array.isArray(json.scans) ? json.scans.map(normalizeScan) : [];
        nextId = json.nextId || (scans.length > 0 ? Math.max(...scans.map(s => s.id)) + 1 : 1);
        console.log(`Data restored from Telegram (${scans.length} scans).`);
    } catch (err) {
        console.error('Error loading data from Telegram:', err.message);
    }
}

async function saveToTelegram() {
    if (!TG_ENABLED) return;
    try {
        const json = JSON.stringify({ scans, nextId }, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const formData = new FormData();
        formData.append('chat_id', TG_CHAT_ID);
        formData.append('document', blob, 'scans.json');
        formData.append('caption', `Data backup - ${new Date().toISOString()} - ${scans.length} scans`);
        const res = await fetch(`${TG_API}/sendDocument`, { method: 'POST', body: formData });
        const data = await res.json();
        if (data.ok) {
            const pinRes = await fetch(`${TG_API}/pinChatMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: TG_CHAT_ID, message_id: data.result.message_id, disable_notification: true })
            });
            const pinData = await pinRes.json();
            if (!pinData.ok) {
                throw new Error(pinData.description || 'Failed to pin Telegram backup message');
            }
            lastTelegramSyncAt = new Date().toISOString();
            lastTelegramSyncError = null;
            console.log(`Data saved to Telegram (${scans.length} scans).`);
        } else {
            throw new Error(data.description || 'Telegram backup upload failed');
        }
    } catch (err) {
        lastTelegramSyncError = err.message;
        console.error('Error saving data to Telegram:', err.message);
        throw err;
    }
}

// Upload image to Telegram and return file_id
async function uploadToTelegram(base64Data) {
    if (!TG_ENABLED) {
        throw new Error('Telegram storage is not configured');
    }
    try {
        const commaIdx = base64Data.indexOf(',');
        if (commaIdx === -1) return null;
        const raw = base64Data.substring(commaIdx + 1);
        const buffer = Buffer.from(raw, 'base64');
        console.log(`Uploading ${buffer.length} bytes to Telegram...`);
        // Try sendPhoto first, fallback to sendDocument
        const blob = new Blob([buffer], { type: 'image/jpeg' });
        const formData = new FormData();
        formData.append('chat_id', TG_CHAT_ID);
        formData.append('photo', blob, 'scan.jpg');
        const response = await fetch(`${TG_API}/sendPhoto`, { method: 'POST', body: formData });
        const data = await response.json();
        if (data.ok && data.result.photo) {
            const photos = data.result.photo;
            const fileId = photos[photos.length - 1].file_id;
            console.log('Telegram upload success (photo), file_id:', fileId.substring(0, 20) + '...');
            return fileId;
        }
        console.log('sendPhoto failed, trying sendDocument...');
        const formData2 = new FormData();
        formData2.append('chat_id', TG_CHAT_ID);
        formData2.append('document', blob, 'scan.jpg');
        const response2 = await fetch(`${TG_API}/sendDocument`, { method: 'POST', body: formData2 });
        const data2 = await response2.json();
        if (data2.ok && data2.result.document) {
            const fileId = data2.result.document.file_id;
            console.log('Telegram upload success (document), file_id:', fileId.substring(0, 20) + '...');
            return fileId;
        }
        throw new Error(data2.description || 'Telegram image upload failed');
    } catch (err) {
        console.error('Telegram upload error:', err.message);
        throw err;
    }
}

function cloneScan(scan) {
    return {
        id: scan.id,
        package_name: scan.package_name,
        scan_date: scan.scan_date,
        image_path: scan.image_path,
        telegram_file_id: scan.telegram_file_id,
        ai_description: scan.ai_description
    };
}

// --- API Endpoints ---

// Record a scan
app.post('/api/scan', async (req, res) => {
    try {
        const { packageName, imageBase64 } = req.body;
        console.log(`POST /api/scan - packageName: ${packageName}, hasImage: ${!!imageBase64}`);
        if (!packageName) return res.status(400).json({ error: 'Package name is required' });

        let imagePath = null;
        let telegramFileId = null;
        if (imageBase64) {
            telegramFileId = await uploadToTelegram(imageBase64);
            if (telegramFileId) {
                imagePath = `/api/image/${encodeURIComponent(telegramFileId)}`;
            }
        }

        const scan = {
            id: nextId++,
            package_name: packageName,
            scan_date: new Date().toISOString().replace('T', ' ').substring(0, 19),
            image_path: imagePath,
            telegram_file_id: telegramFileId,
            ai_description: null
        };
        scans.push(scan);
        if (TG_ENABLED) {
            try {
                await saveToTelegram();
            } catch (error) {
                scans = scans.filter(item => item.id !== scan.id);
                nextId = scan.id;
                return res.status(502).json({ error: `Failed to save scan to Telegram: ${error.message}` });
            }
        }

        res.json({ success: true, message: 'Scan recorded successfully', id: scan.id, packageName, imagePath });
    } catch (error) {
        console.error('Error recording scan:', error);
        res.status(500).json({ error: 'Failed to record scan' });
    }
});

// Fetch recent scans
app.get('/api/scans', (req, res) => {
    const recent = [...scans].sort((a, b) => b.id - a.id).slice(0, 50);
    res.json(recent);
});

app.get('/api/telegram-status', (req, res) => {
    res.json({
        enabled: TG_ENABLED,
        chatIdConfigured: Boolean(TG_CHAT_ID),
        botTokenConfigured: Boolean(TG_BOT_TOKEN),
        lastTelegramSyncAt,
        lastTelegramSyncError
    });
});

// Image proxy from Telegram
app.get('/api/image/:fileId(*)', async (req, res) => {
    try {
        if (!TG_ENABLED) return res.status(500).json({ error: 'Telegram storage is not configured' });
        const fileId = decodeURIComponent(req.params.fileId);
        const fileRes = await fetch(`${TG_API}/getFile?file_id=${encodeURIComponent(fileId)}`);
        const fileData = await fileRes.json();
        if (!fileData.ok || !fileData.result.file_path) return res.status(404).json({ error: 'File not found' });
        const fileUrl = `https://api.telegram.org/file/bot${TG_BOT_TOKEN}/${fileData.result.file_path}`;
        const imageRes = await fetch(fileUrl);
        const ct = imageRes.headers.get('content-type');
        res.set('Content-Type', (ct && ct.startsWith('image/')) ? ct : 'image/jpeg');
        res.set('Cache-Control', 'public, max-age=86400');
        const imgBuf = Buffer.from(await imageRes.arrayBuffer());
        // Detect actual image type from magic bytes
        if (imgBuf[0] === 0x89 && imgBuf[1] === 0x50) res.set('Content-Type', 'image/png');
        else if (imgBuf[0] === 0xFF && imgBuf[1] === 0xD8) res.set('Content-Type', 'image/jpeg');
        else if (imgBuf[0] === 0x47 && imgBuf[1] === 0x49) res.set('Content-Type', 'image/gif');
        res.send(imgBuf);
    } catch (error) {
        console.error('Error fetching image from Telegram:', error);
        res.status(500).json({ error: 'Failed to fetch image' });
    }
});

// Delete a scan
app.delete('/api/scans/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    const idx = scans.findIndex(s => s.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Scan not found' });
    const deletedScan = cloneScan(scans[idx]);
    scans.splice(idx, 1);
    if (TG_ENABLED) {
        try {
            await saveToTelegram();
        } catch (error) {
            scans.splice(idx, 0, deletedScan);
            return res.status(502).json({ error: `Failed to delete scan from Telegram backup: ${error.message}` });
        }
    }
    res.json({ success: true, message: 'Scan deleted successfully' });
});

// Update a scan
app.put('/api/scans/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    const { packageName, scanDate, aiDescription } = req.body;
    const scan = scans.find(s => s.id === id);
    if (!scan) return res.status(404).json({ error: 'Scan not found' });
    const previousScan = cloneScan(scan);
    if (packageName) scan.package_name = packageName;
    if (scanDate) scan.scan_date = scanDate;
    if (typeof aiDescription === 'string') scan.ai_description = aiDescription.trim() || null;
    if (TG_ENABLED) {
        try {
            await saveToTelegram();
        } catch (error) {
            Object.assign(scan, previousScan);
            return res.status(502).json({ error: `Failed to update Telegram backup: ${error.message}` });
        }
    }
    res.json({ success: true, message: 'Scan updated successfully' });
});

// Startup
async function startup() {
    await loadFromTelegram();
    console.log('Database ready (Telegram-backed).');
    app.listen(port, () => {
        console.log(`Pesticide Scanner app listening at http://localhost:${port}`);
    });
}
startup();

// NVIDIA AI Endpoints
const NVAPI_KEY = process.env.NVAPI_KEY;
const NVAPI_URL = "https://integrate.api.nvidia.com/v1/chat/completions";

function extractStreamContent(eventData) {
    const choice = eventData.choices && eventData.choices[0];
    if (!choice) return '';

    if (typeof choice.delta?.content === 'string') {
        return choice.delta.content;
    }
    if (typeof choice.message?.content === 'string') {
        return choice.message.content;
    }
    return '';
}

function parseNvidiaStream(rawBody, label) {
    const lines = rawBody.split(/\r?\n/);
    let combinedContent = '';

    for (const line of lines) {
        if (!line.startsWith('data:')) {
            continue;
        }

        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') {
            continue;
        }

        try {
            const eventData = JSON.parse(payload);
            combinedContent += extractStreamContent(eventData);
        } catch (error) {
            console.error(`${label} stream event was invalid JSON:`, payload.slice(0, 500));
            return { ok: false, error: 'AI service returned an invalid stream response' };
        }
    }

    if (!combinedContent.trim()) {
        return { ok: false, error: 'AI service returned an empty stream response' };
    }

    return {
        ok: true,
        data: {
            choices: [{
                message: {
                    content: combinedContent.trim()
                }
            }]
        }
    };
}

async function callNvidiaApi(payload, label, options = {}) {
    if (!NVAPI_KEY) {
        return { ok: false, error: 'NVAPI_KEY is not configured on the server' };
    }

    const useStream = Boolean(payload.stream);
    const timeoutMs = options.timeoutMs || 15000;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
        response = await fetch(NVAPI_URL, {
            method: 'POST',
            headers: {
                "Authorization": `Bearer ${NVAPI_KEY}`,
                "Accept": useStream ? "text/event-stream" : "application/json",
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload),
            signal: controller.signal
        });
    } catch (error) {
        clearTimeout(timeout);
        if (error.name === 'AbortError') {
            console.error(`${label} request timed out.`);
            return { ok: false, error: 'AI service timed out' };
        }
        throw error;
    }

    clearTimeout(timeout);

    const rawBody = await response.text();
    if (!rawBody.trim()) {
        console.error(`${label} returned an empty response body.`);
        return { ok: false, error: 'AI service returned an empty response' };
    }

    if (useStream) {
        return parseNvidiaStream(rawBody, label);
    }

    let data;
    try {
        data = JSON.parse(rawBody);
    } catch (error) {
        console.error(`${label} returned invalid JSON:`, rawBody.slice(0, 500));
        return { ok: false, error: 'AI service returned an invalid response' };
    }

    if (!response.ok) {
        console.error(`${label} request failed:`, response.status, data);
        return { ok: false, error: data.error?.message || data.description || `AI service request failed with status ${response.status}` };
    }

    return { ok: true, data };
}

app.post('/api/pesticide-info', async (req, res) => {
    try {
        const { packageName, scanId } = req.body;
        if (!packageName) return res.status(400).json({ error: 'Package name missing' });

        const payload = {
            model: "moonshotai/kimi-k2.5",
            messages: [{
                role: "user",
                content: `Provide a short, 2-3 sentence informational summary about the pesticide product '${packageName}', including its uses and safety precautions.`
            }],
            max_tokens: 1024,
            temperature: 0.7,
            top_p: 1.0,
            stream: false
        };

        const result = await callNvidiaApi(payload, 'NV API');
        if (!result.ok) {
            return res.status(502).json({ error: result.error });
        }

        const data = result.data;
        if (data.choices && data.choices[0]) {
            const info = data.choices[0].message.content.trim();
            if (scanId !== undefined && scanId !== null) {
                const numericId = parseInt(scanId, 10);
                const scan = scans.find(item => item.id === numericId);
                if (scan) {
                    const previousDescription = scan.ai_description;
                    scan.ai_description = info;
                    if (TG_ENABLED) {
                        try {
                            await saveToTelegram();
                        } catch (error) {
                            scan.ai_description = previousDescription;
                            return res.status(502).json({ error: `Failed to save AI description to Telegram: ${error.message}` });
                        }
                    }
                }
            }
            res.json({ info });
        } else {
            console.error("NV API Error:", data);
            res.status(502).json({ error: 'AI service returned no completion' });
        }
    } catch (err) {
        console.error("AI fetch error:", err);
        res.status(500).json({ error: 'Failed to fetch AI info' });
    }
});

app.post('/api/analyze-image', async (req, res) => {
    try {
        const { imageBase64 } = req.body;
        if (!imageBase64) return res.status(400).json({ error: 'Image missing' });

        const payload = {
            model: "mistralai/mistral-large-3-675b-instruct-2512",
            messages: [{
                role: "user",
                content: `What is the name of the pesticide product shown in this image? Reply with ONLY the product name. Do not add conversational text. <img src="${imageBase64}" />`
            }],
            max_tokens: 64,
            temperature: 0.15,
            top_p: 1.0,
            frequency_penalty: 0.0,
            presence_penalty: 0.0,
            stream: true
        };

        const result = await callNvidiaApi(payload, 'NV Vision API', { timeoutMs: 45000 });
        if (!result.ok) {
            return res.status(502).json({ error: result.error });
        }

        const data = result.data;
        if (data.choices && data.choices[0]) {
            res.json({ name: data.choices[0].message.content.trim() });
        } else {
            console.error("NV Vision API Error:", data);
            res.status(502).json({ error: 'AI service returned no completion' });
        }
    } catch (err) {
        console.error("Vision AI fetch error:", err);
        res.status(500).json({ error: 'Image analysis failed' });
    }
});
