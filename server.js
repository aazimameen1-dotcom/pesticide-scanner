require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Telegram Bot Config
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const TG_API = TG_BOT_TOKEN ? `https://api.telegram.org/bot${TG_BOT_TOKEN}` : null;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Serve frontend static files
app.use(express.static(path.join(__dirname, 'public')));

// --- In-memory database backed by Telegram ---
let scans = [];
let nextId = 1;
let syncTimer = null;

async function loadFromTelegram() {
    if (!TG_API) { console.log('Telegram not configured, starting with empty DB.'); return; }
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
        scans = json.scans || [];
        nextId = json.nextId || (scans.length > 0 ? Math.max(...scans.map(s => s.id)) + 1 : 1);
        console.log(`Data restored from Telegram (${scans.length} scans).`);
    } catch (err) {
        console.error('Error loading data from Telegram:', err.message);
    }
}

async function saveToTelegram() {
    if (!TG_API) return;
    try {
        const json = JSON.stringify({ scans, nextId }, null, 2);
        const file = new File([json], 'scans.json', { type: 'application/json' });
        const formData = new FormData();
        formData.append('chat_id', TG_CHAT_ID);
        formData.append('document', file);
        formData.append('caption', `Data backup - ${new Date().toISOString()} - ${scans.length} scans`);
        const res = await fetch(`${TG_API}/sendDocument`, { method: 'POST', body: formData });
        const data = await res.json();
        if (data.ok) {
            await fetch(`${TG_API}/pinChatMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: TG_CHAT_ID, message_id: data.result.message_id, disable_notification: true })
            });
            console.log(`Data saved to Telegram (${scans.length} scans).`);
        } else {
            console.error('Data save failed:', data.description);
        }
    } catch (err) {
        console.error('Error saving data to Telegram:', err.message);
    }
}

function scheduleSave() {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => saveToTelegram(), 2000);
}

// Upload image to Telegram and return file_id
async function uploadToTelegram(base64Data) {
    if (!TG_API) {
        console.log('Telegram not configured, skipping upload');
        return null;
    }
    try {
        const commaIdx = base64Data.indexOf(',');
        if (commaIdx === -1) return null;
        const raw = base64Data.substring(commaIdx + 1);
        const buffer = Buffer.from(raw, 'base64');
        console.log(`Uploading ${buffer.length} bytes to Telegram...`);
        const file = new File([buffer], 'scan.jpg', { type: 'image/jpeg' });
        const formData = new FormData();
        formData.append('chat_id', TG_CHAT_ID);
        formData.append('photo', file);
        const response = await fetch(`${TG_API}/sendPhoto`, { method: 'POST', body: formData });
        const data = await response.json();
        if (data.ok && data.result.photo) {
            const photos = data.result.photo;
            const fileId = photos[photos.length - 1].file_id;
            console.log('Telegram upload success, file_id:', fileId.substring(0, 20) + '...');
            return fileId;
        }
        console.error('Telegram upload failed:', JSON.stringify(data));
        return null;
    } catch (err) {
        console.error('Telegram upload error:', err.message);
        return null;
    }
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
            telegram_file_id: telegramFileId
        };
        scans.push(scan);
        scheduleSave();

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

// Image proxy from Telegram
app.get('/api/image/:fileId(*)', async (req, res) => {
    try {
        if (!TG_API) return res.status(500).json({ error: 'Telegram not configured' });
        const fileId = decodeURIComponent(req.params.fileId);
        const fileRes = await fetch(`${TG_API}/getFile?file_id=${encodeURIComponent(fileId)}`);
        const fileData = await fileRes.json();
        if (!fileData.ok || !fileData.result.file_path) return res.status(404).json({ error: 'File not found' });
        const fileUrl = `https://api.telegram.org/file/bot${TG_BOT_TOKEN}/${fileData.result.file_path}`;
        const imageRes = await fetch(fileUrl);
        res.set('Content-Type', imageRes.headers.get('content-type') || 'image/jpeg');
        res.set('Cache-Control', 'public, max-age=86400');
        res.send(Buffer.from(await imageRes.arrayBuffer()));
    } catch (error) {
        console.error('Error fetching image from Telegram:', error);
        res.status(500).json({ error: 'Failed to fetch image' });
    }
});

// Delete a scan
app.delete('/api/scans/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const idx = scans.findIndex(s => s.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Scan not found' });
    scans.splice(idx, 1);
    scheduleSave();
    res.json({ success: true, message: 'Scan deleted successfully' });
});

// Update a scan
app.put('/api/scans/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const { packageName, scanDate } = req.body;
    const scan = scans.find(s => s.id === id);
    if (!scan) return res.status(404).json({ error: 'Scan not found' });
    if (packageName) scan.package_name = packageName;
    if (scanDate) scan.scan_date = scanDate;
    scheduleSave();
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
const NVAPI_KEY = "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";
const NVAPI_URL = "https://integrate.api.nvidia.com/v1/chat/completions";

app.post('/api/pesticide-info', async (req, res) => {
    try {
        const { packageName } = req.body;
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

        const response = await fetch(NVAPI_URL, {
            method: 'POST',
            headers: {
                "Authorization": `Bearer ${NVAPI_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
        });

        const data = await response.json();
        if (data.choices && data.choices[0]) {
            res.json({ info: data.choices[0].message.content });
        } else {
            console.error("NV API Error:", data);
            res.status(500).json({ error: 'Failed to fetch AI info' });
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
            model: "meta/llama-3.2-90b-vision-instruct", 
            messages: [{
                role: "user",
                content: [
                    { type: "text", text: "What is the name of the pesticide product shown in this image? Reply with ONLY the product name (e.g. 'Roundup', 'Ortho', 'Bifen IT'). Do not add any conversational text." },
                    { type: "image_url", image_url: { url: imageBase64 } }
                ]
            }],
            max_tokens: 128,
            temperature: 0.2,
            top_p: 1.0,
            stream: false
        };

        const response = await fetch(NVAPI_URL, {
            method: 'POST',
            headers: {
                "Authorization": `Bearer ${NVAPI_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
        });

        const data = await response.json();
        if (data.choices && data.choices[0]) {
            res.json({ name: data.choices[0].message.content.trim() });
        } else {
            console.error("NV Vision API Error:", data);
            res.status(500).json({ error: 'Failed to analyze text from image' });
        }
    } catch (err) {
        console.error("Vision AI fetch error:", err);
        res.status(500).json({ error: 'Image analysis failed' });
    }
});
