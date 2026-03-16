# EcoScan: Pesticide Package Scanner

This application lets users scan pesticide packages with a camera or enter them manually, then stores the scan log in Telegram instead of MySQL.

## Requirements
- Node.js 18 or later
- A Telegram bot token
- A Telegram chat or channel ID where the bot can post files

## Telegram Storage Setup
1. Create a bot with BotFather and copy the bot token.
2. Add the bot to the target group, channel, or private chat.
3. Make sure the bot can send messages and pin messages in that chat.
4. Create a `.env` file from `.env.example` and set:

```env
PORT=3000
TG_BOT_TOKEN=your_bot_token_here
TG_CHAT_ID=your_chat_id_here
```

The server stores scan records in memory while running and periodically uploads a `scans.json` backup to Telegram. The latest pinned backup is used to restore data on startup.

## Running the App

### 1. Install dependencies
```bash
npm install
```

### 2. Start the server
```bash
npm start
```

### 3. Open the app
Visit http://localhost:3000

## Features
- Camera capture and AI-assisted label extraction
- Manual package entry fallback
- Recent scan history with edit and delete actions
- Telegram-backed record storage and image hosting
