require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Serve frontend static files
app.use(express.static(path.join(__dirname, 'public')));

// Database connection configuration
const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root', 
    password: process.env.DB_PASSWORD || 'password', 
    database: process.env.DB_NAME || 'pesticide_db',
    port: parseInt(process.env.DB_PORT) || 3306,
    ssl: process.env.DB_HOST && process.env.DB_HOST !== 'localhost' 
        ? { rejectUnauthorized: true } 
        : undefined,
};

// Test DB Connection and ensure table exists
async function initDB() {
    try {
        // Connect to the database
        const pool = mysql.createPool(dbConfig);
        
        // Create table if it doesn't exist
        await pool.query(`
            CREATE TABLE IF NOT EXISTS scans (
                id INT AUTO_INCREMENT PRIMARY KEY,
                package_name VARCHAR(255) NOT NULL,
                scan_date DATETIME NOT NULL
            )
        `);
        
        // Add image_path column if not exists (fallback for existing dbs)
        try {
            await pool.query('ALTER TABLE scans ADD COLUMN image_path VARCHAR(255)');
        } catch (colErr) {
            // Ignore error assuming it implies column already exists
        }
        console.log('Database and table ready.');
        return pool;
    } catch (error) {
        console.error('Error initializing database. Make sure MySQL is running and credentials are correct:', error.message);
        // We will keep running to serve frontend even if DB fails, but insertions will fail
    }
}

let dbPool;
initDB().then(pool => { dbPool = pool; });

// API endpoint to record a scan
app.post('/api/scan', async (req, res) => {
    try {
        const { packageName, imageBase64 } = req.body;
        
        if (!packageName) {
            return res.status(400).json({ error: 'Package name is required' });
        }
        
        if (!dbPool) {
            return res.status(500).json({ error: 'Database connection is not available' });
        }

        // Save image if present
        let imagePath = null;
        if (imageBase64) {
            const matches = imageBase64.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
            if (matches && matches.length === 3) {
                const buffer = Buffer.from(matches[2], 'base64');
                const filename = Date.now() + '.jpg';
                const fileDir = path.join(__dirname, 'public', 'uploads', filename);
                fs.writeFileSync(fileDir, buffer);
                imagePath = '/uploads/' + filename;
            }
        }

        // We use MySQL's NOW() function for the current date and time
        const [result] = await dbPool.query(
            'INSERT INTO scans (package_name, scan_date, image_path) VALUES (?, NOW(), ?)',
            [packageName, imagePath]
        );
        
        res.json({ 
            success: true, 
            message: 'Scan recorded successfully',
            id: result.insertId,
            packageName: packageName,
            imagePath: imagePath
        });
    } catch (error) {
        console.error('Error recording scan:', error);
        res.status(500).json({ error: 'Failed to record scan' });
    }
});

// API endpoint to fetch recent scans (optional, for the UI to display)
app.get('/api/scans', async (req, res) => {
    try {
        if (!dbPool) {
            return res.status(500).json({ error: 'Database connection is not available' });
        }

        const [rows] = await dbPool.query(
            'SELECT id, package_name, scan_date, image_path FROM scans ORDER BY scan_date DESC LIMIT 50'
        );
        res.json(rows);
    } catch (error) {
        console.error('Error fetching scans:', error);
        res.status(500).json({ error: 'Failed to fetch scans' });
    }
});

// API endpoint to delete a scan
app.delete('/api/scans/:id', async (req, res) => {
    try {
        const id = req.params.id;
        if (!dbPool) {
            return res.status(500).json({ error: 'Database connection is not available' });
        }
        
        // Find existing record to delete image file if exists
        const [rows] = await dbPool.query('SELECT image_path FROM scans WHERE id = ?', [id]);
        if (rows.length > 0 && rows[0].image_path) {
            const filepath = path.join(__dirname, 'public', rows[0].image_path);
            if (fs.existsSync(filepath)) {
                fs.unlinkSync(filepath);
            }
        }
        
        await dbPool.query('DELETE FROM scans WHERE id = ?', [id]);
        res.json({ success: true, message: 'Scan deleted successfully' });
    } catch (error) {
        console.error('Error deleting scan:', error);
        res.status(500).json({ error: 'Failed to delete scan' });
    }
});

// API endpoint to update a scan
app.put('/api/scans/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const { packageName, scanDate } = req.body;
        
        if (!dbPool) {
            return res.status(500).json({ error: 'Database connection is not available' });
        }
        
        if (scanDate) {
            await dbPool.query('UPDATE scans SET package_name = ?, scan_date = ? WHERE id = ?', [packageName, new Date(scanDate), id]);
        } else {
            await dbPool.query('UPDATE scans SET package_name = ? WHERE id = ?', [packageName, id]);
        }
        
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
