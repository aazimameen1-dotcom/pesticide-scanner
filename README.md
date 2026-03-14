# EcoScan: Pesticide Package Scanner

This full-stack application allows users to scan pesticide package barcodes using their device camera or manually enter them. It records the package names and scan timestamps into a MySQL database.

## System Requirements
- **Node.js**: Make sure Node.js is installed.
- **MySQL**: Have a local MySQL server installed and running.

## Configuration
Before running the server, please set up your database connection.
1. Open the file `server.js` located in this directory.
2. Under the `dbConfig` constant, update the `user` and `password` variables to match your local MySQL credentials:

```javascript
const dbConfig = {
    host: 'localhost',
    user: 'root', // <-- Update this
    password: '', // <-- Update this
    database: 'pesticide_db',
};
```

## Running the App

### 1. Install Dependencies
If you haven't already, run the following command in this folder (I have already done this during development, but run it if modules are missing):
```bash
npm install
```

### 2. Start the Server
Start the Express server which hosts both the API and the web frontend.
```bash
npm start
```
*Note: The script will automatically connect to MySQL and create the `pesticide_db` database and the `scans` table if they don't already exist.*

### 3. Open the Website
Open your web browser and go to:
### [http://localhost:3000](http://localhost:3000)

## Features
- **Camera Scanner**: Utilizes `html5-qrcode` to use your computer webcam or smartphone camera to capture barcode/QR information and save it directly to the database.
- **Manual Form Backup**: In case a code is ripped, use the manual entry form to type the ID by hand.
- **Real-time Logging**: A clean, modern interface styled completely with Vanilla CSS displaying a beautifully-rendered tracker table.
