require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

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

// SQLite database setup
const dbPath = path.join(__dirname, 'pesticide.db');
let db;

function initDB() {
    try {
        db = new Database(dbPath);
        db.pragma('journal_mode = WAL');

        db.exec(`
            CREATE TABLE IF NOT EXISTS scans (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                package_name TEXT NOT NULL,
                scan_date TEXT NOT NULL,
                image_path TEXT,
                telegram_file_id TEXT
            )
        `);

        // Add telegram_file_id column if upgrading from older schema
        try {
            db.exec('ALTER TABLE scans ADD COLUMN telegram_file_id TEXT');
        } catch (e) {
            // Column already exists
        }

        console.log('Database and table ready.');
    } catch (error) {
        console.error('Error initializing database:', error.message);
    }
}

// --- Telegram DB Backup/Restore ---
let dbBackupTimer = null;

async function downloadDBFromTelegram() {
    if (!TG_API) return false;
    try {
        // Get pinned message from channel which contains the latest DB backup
        const chatRes = await fetch(`${TG_API}/getChat?chat_id=${encodeURIComponent(TG_CHAT_ID)}`);
        const chatData = await chatRes.json();
        if (!chatData.ok || !chatData.result.pinned_message || !chatData.result.pinned_message.document) {
            console.log('No DB backup found in Telegram, starting fresh.');
            return false;
        }
        const doc = chatData.result.pinned_message.document;
        if (doc.file_name !== 'pesticide.db') {
            console.log('Pinned message is not a DB backup, starting fresh.');
            return false;
        }
        // Download the file
        const fileRes = await fetch(`${TG_API}/getFile?file_id=${encodeURIComponent(doc.file_id)}`);
        const fileData = await fileRes.json();
        if (!fileData.ok || !fileData.result.file_path) return false;
        const fileUrl = `https://api.telegram.org/file/bot${TG_BOT_TOKEN}/${fileData.result.file_path}`;
        const dlRes = await fetch(fileUrl);
        const buffer = Buffer.from(await dlRes.arrayBuffer());
        fs.writeFileSync(dbPath, buffer);
        console.log(`DB restored from Telegram (${buffer.length} bytes).`);
        return true;
    } catch (err) {
        console.error('Error downloading DB from Telegram:', err.message);
        return false;
    }
}

async function uploadDBToTelegram() {
    if (!TG_API || !db) return;
    try {
        // Checkpoint WAL to ensure DB file is complete
        db.pragma('wal_checkpoint(TRUNCATE)');
        const buffer = fs.readFileSync(dbPath);
        const file = new File([buffer], 'pesticide.db', { type: 'application/octet-stream' });
        const formData = new FormData();
        formData.append('chat_id', TG_CHAT_ID);
        formData.append('document', file);
        formData.append('caption', `DB backup - ${new Date().toISOString()}`);
        const res = await fetch(`${TG_API}/sendDocument`, { method: 'POST', body: formData });
        const data = await res.json();
        if (data.ok) {
            // Pin this message so we can find it on next startup
            await fetch(`${TG_API}/pinChatMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: TG_CHAT_ID, message_id: data.result.message_id, disable_notification: true })
            });
            console.log('DB backed up to Telegram.');
        } else {
            console.error('DB backup upload failed:', data.description);
        }
    } catch (err) {
        console.error('Error uploading DB to Telegram:', err.message);
    }
}

// Debounced backup: waits 2s after last write before uploading
function scheduleDBBackup() {
    if (dbBackupTimer) clearTimeout(dbBackupTimer);
    dbBackupTimer = setTimeout(() => uploadDBToTelegram(), 2000);
}

// Startup: restore DB from Telegram, then init
async function startup() {
    await downloadDBFromTelegram();
    initDB();
}

startup();

// Upload image to Telegram and return file_id
async function uploadToTelegram(base64Data) {
    if (!TG_API) {
        console.log('Telegram not configured, skipping upload');
        return null;
    }
    
    try {
        // Extract base64 content
        const commaIdx = base64Data.indexOf(',');
        if (commaIdx === -1) return null;
        const raw = base64Data.substring(commaIdx + 1);
        
        const buffer = Buffer.from(raw, 'base64');
        console.log(`Uploading ${buffer.length} bytes to Telegram...`);
        
        const file = new File([buffer], 'scan.jpg', { type: 'image/jpeg' });
        
        const formData = new FormData();
        formData.append('chat_id', TG_CHAT_ID);
        formData.append('photo', file);
        
        const response = await fetch(`${TG_API}/sendPhoto`, {
            method: 'POST',
            body: formData
        });
        
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

// API endpoint to record a scan
app.post('/api/scan', async (req, res) => {
    try {
        const { packageName, imageBase64 } = req.body;
        console.log(`POST /api/scan - packageName: ${packageName}, hasImage: ${!!imageBase64}, imageLength: ${imageBase64 ? imageBase64.length : 0}`);
        
        if (!packageName) {
            return res.status(400).json({ error: 'Package name is required' });
        }
        
        if (!db) {
            return res.status(500).json({ error: 'Database connection is not available' });
        }

        // Upload image to Telegram if present, fallback to local
        let imagePath = null;
        let telegramFileId = null;
        if (imageBase64) {
            telegramFileId = await uploadToTelegram(imageBase64);
            if (telegramFileId) {
                imagePath = `/api/image/${encodeURIComponent(telegramFileId)}`;
            } else {
                // Fallback: save locally if Telegram fails
                const commaIdx = imageBase64.indexOf(',');
                if (commaIdx !== -1) {
                    const buffer = Buffer.from(imageBase64.substring(commaIdx + 1), 'base64');
                    const uploadsDir = path.join(__dirname, 'public', 'uploads');
                    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
                    const filename = Date.now() + '.jpg';
                    fs.writeFileSync(path.join(uploadsDir, filename), buffer);
                    imagePath = '/uploads/' + filename;
                }
            }
        }

        const stmt = db.prepare('INSERT INTO scans (package_name, scan_date, image_path, telegram_file_id) VALUES (?, datetime(\'now\'), ?, ?)');
        const result = stmt.run(packageName, imagePath, telegramFileId);
        scheduleDBBackup();
        
        res.json({ 
            success: true, 
            message: 'Scan recorded successfully',
            id: result.lastInsertRowid,
            packageName: packageName,
            imagePath: imagePath
        });
    } catch (error) {
        console.error('Error recording scan:', error);
        res.status(500).json({ error: 'Failed to record scan' });
    }
});

// API endpoint to fetch recent scans (optional, for the UI to display)
app.get('/api/scans', (req, res) => {
    try {
        if (!db) {
            return res.status(500).json({ error: 'Database connection is not available' });
        }

        const rows = db.prepare('SELECT id, package_name, scan_date, image_path, telegram_file_id FROM scans ORDER BY scan_date DESC LIMIT 50').all();
        res.json(rows);
    } catch (error) {
        console.error('Error fetching scans:', error);
        res.status(500).json({ error: 'Failed to fetch scans' });
    }
});

// Proxy endpoint to serve images from Telegram
app.get('/api/image/:fileId(*)', async (req, res) => {
    try {
        if (!TG_API) return res.status(500).json({ error: 'Telegram not configured' });
        
        const fileId = decodeURIComponent(req.params.fileId);
        console.log('Image proxy request for:', fileId.substring(0, 20) + '...');
        const fileRes = await fetch(`${TG_API}/getFile?file_id=${encodeURIComponent(fileId)}`);
        const fileData = await fileRes.json();
        
        if (!fileData.ok || !fileData.result.file_path) {
            return res.status(404).json({ error: 'File not found' });
        }
        
        const fileUrl = `https://api.telegram.org/file/bot${TG_BOT_TOKEN}/${fileData.result.file_path}`;
        const imageRes = await fetch(fileUrl);
        
        res.set('Content-Type', imageRes.headers.get('content-type') || 'image/jpeg');
        res.set('Cache-Control', 'public, max-age=86400');
        const buffer = Buffer.from(await imageRes.arrayBuffer());
        res.send(buffer);
    } catch (error) {
        console.error('Error fetching image from Telegram:', error);
        res.status(500).json({ error: 'Failed to fetch image' });
    }
});

// API endpoint to delete a scan
app.delete('/api/scans/:id', (req, res) => {
    try {
        const id = req.params.id;
        if (!db) {
            return res.status(500).json({ error: 'Database connection is not available' });
        }
        
        db.prepare('DELETE FROM scans WHERE id = ?').run(id);
        scheduleDBBackup();
        res.json({ success: true, message: 'Scan deleted successfully' });
    } catch (error) {
        console.error('Error deleting scan:', error);
        res.status(500).json({ error: 'Failed to delete scan' });
    }
});

// API endpoint to update a scan
app.put('/api/scans/:id', (req, res) => {
    try {
        const id = req.params.id;
        const { packageName, scanDate } = req.body;
        
        if (!db) {
            return res.status(500).json({ error: 'Database connection is not available' });
        }
        
        if (scanDate) {
            db.prepare('UPDATE scans SET package_name = ?, scan_date = ? WHERE id = ?').run(packageName, scanDate, id);
        } else {
            db.prepare('UPDATE scans SET package_name = ? WHERE id = ?').run(packageName, id);
        }
        scheduleDBBackup();
        
        res.json({ success: true, message: 'Scan updated successfully' });
    } catch (error) {
        console.error('Error updating scan:', error);
        res.status(500).json({ error: 'Failed to update scan' });
    }
});

app.listen(port, () => {
    console.log(`Pesticide Scanner app listening at http://localhost:${port}`);
});

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
