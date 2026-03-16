// Setup elements
const startScanBtn = document.getElementById('start-scan-btn');
const captureBtn = document.getElementById('capture-btn');
const captureInput = document.getElementById('capture-image-input');
const manualEntryBtn = document.getElementById('manual-entry-btn');
const cancelManualBtn = document.getElementById('cancel-manual-btn');
const readerContainer = document.getElementById('reader-container');
const manualForm = document.getElementById('manual-form');
const recordForm = document.getElementById('record-form');
const packageNameInput = document.getElementById('package-name');
const scansList = document.getElementById('scans-list');
const noScansMsg = document.getElementById('no-scans-msg');
const notification = document.getElementById('notification');
// Modal Elements
const aiModal = document.getElementById('ai-modal');
const aiModalBackdrop = document.getElementById('ai-modal-backdrop');
const aiModalClose = document.getElementById('ai-modal-close');
const aiModalTitle = document.getElementById('ai-modal-title');
const aiModalContent = document.getElementById('ai-modal-content');

const imageModal = document.getElementById('image-modal');
const imageModalContent = document.getElementById('image-modal-content');
const imageModalClose = document.getElementById('image-modal-close');
const imageModalTitle = document.getElementById('image-modal-title');
const imageModalInfo = document.getElementById('image-modal-info');

// Edit Modal Elements
const editModal = document.getElementById('edit-modal');
const editForm = document.getElementById('edit-form');
const editIdInput = document.getElementById('edit-id');
const editPackageNameInput = document.getElementById('edit-package-name');
const editScanDateInput = document.getElementById('edit-scan-date');
const editModalClose = document.getElementById('edit-modal-close');

let stream = null;
let isScanning = false;
let currentFacingMode = 'environment'; // 'environment' = back camera, 'user' = front camera
let aiCache = {}; // Cache to store Kimi AI descriptions by scan ID
let pendingImageBase64 = null;

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
    fetchScans();
});

// Start Scanner Event
startScanBtn.addEventListener('click', () => {
    if (isScanning) {
        stopScanner();
    } else {
        startScanner();
    }
});

// Image Capture Event (AI Vision via NVIDIA Llama 3.2 Vision)
captureBtn.addEventListener('click', () => {
    captureInput.click();
});

captureInput.addEventListener('change', e => {
    if (e.target.files.length === 0) return;
    
    if (isScanning) {
        stopScanner();
    }
    
    const imageFile = e.target.files[0];
    showNotification("AI Vision: Reading image label (this may take a few secs)...");
    
    const reader = new FileReader();
    reader.onload = async (event) => {
        const base64Data = event.target.result;
        try {
            const response = await fetch('/api/analyze-image', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ imageBase64: base64Data })
            });

            const data = await response.json();
            if (response.ok && data.name) {
                onScanSuccess(cleanDetectedName(data.name), base64Data);
            } else {
                fallbackToManualEntry(base64Data, data.error || "Failed to analyze image.");
            }
        } catch(err) {
            console.error("AI Server Error:", err);
            fallbackToManualEntry(base64Data, "AI text capture failed.");
        } finally {
            captureInput.value = '';
        }
    };
    reader.readAsDataURL(imageFile);
});

// Toggle Manual Entry Mode
manualEntryBtn.addEventListener('click', () => {
    if (isScanning) {
        stopScanner();
    }
    openManualEntry();
});

cancelManualBtn.addEventListener('click', () => {
    manualForm.classList.add('hidden');
    readerContainer.classList.remove('hidden');
    packageNameInput.value = '';
    pendingImageBase64 = null;
});

// Form Submit Event
recordForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const pkgName = packageNameInput.value.trim();
    if (pkgName) {
        recordScan(pkgName, pendingImageBase64);
        packageNameInput.value = '';
        pendingImageBase64 = null;
        manualForm.classList.add('hidden');
        readerContainer.classList.remove('hidden');
    }
});

// Scanner Functions
async function startScanner() {
    isScanning = true;
    startScanBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        Stop Camera
    `;
    startScanBtn.classList.add('outline-btn');
    startScanBtn.classList.remove('primary-btn');
    
    document.getElementById('snap-btn').classList.remove('hidden');
    document.getElementById('switch-cam-btn').classList.remove('hidden');
    const video = document.getElementById('video-feed');
    video.classList.remove('hidden');
    
    try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: currentFacingMode } });
        video.srcObject = stream;
    } catch (err) {
        console.error("Camera error:", err);
        showNotification("Camera access denied or not found.", "error");
        stopScanner();
    }
}

function stopScanner() {
    isScanning = false;
    startScanBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2"></path><path d="M17 3h2a2 2 0 0 1 2 2v2"></path><path d="M21 17v2a2 2 0 0 1-2 2h-2"></path><path d="M7 21H5a2 2 0 0 1-2-2v-2"></path><circle cx="12" cy="12" r="3"></circle></svg>
        Live Camera
    `;
    startScanBtn.classList.remove('outline-btn');
    startScanBtn.classList.add('primary-btn');
    
    document.getElementById('snap-btn').classList.add('hidden');
    document.getElementById('switch-cam-btn').classList.add('hidden');
    
    if (stream) {
        stream.getTracks().forEach(track => track.stop());
        stream = null;
    }
    const video = document.getElementById('video-feed');
    video.classList.add('hidden');
    video.srcObject = null;
}

// Switch Camera (front <-> back)
document.getElementById('switch-cam-btn').addEventListener('click', async () => {
    currentFacingMode = currentFacingMode === 'environment' ? 'user' : 'environment';
    if (stream) {
        stream.getTracks().forEach(track => track.stop());
    }
    const video = document.getElementById('video-feed');
    try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: currentFacingMode } });
        video.srcObject = stream;
    } catch (err) {
        console.error("Camera switch error:", err);
        showNotification("Could not switch camera.", "error");
    }
});

// Snap & Analyze Event
document.getElementById('snap-btn').addEventListener('click', async () => {
    const video = document.getElementById('video-feed');
    const canvas = document.getElementById('snapshot-canvas');
    const context = canvas.getContext('2d');
    
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    
    const base64Data = canvas.toDataURL('image/jpeg');
    
    // Switch to processing stage
    stopScanner();
    showNotification("AI Vision: Extracting packaging info...", "success");
    
    try {
        const response = await fetch('/api/analyze-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ imageBase64: base64Data })
        });

        const data = await response.json();
        if (response.ok && data.name) {
            onScanSuccess(cleanDetectedName(data.name), base64Data);
        } else {
            fallbackToManualEntry(base64Data, data.error || "Failed to analyze image.");
        }
    } catch(err) {
        console.error("AI Server Error:", err);
        fallbackToManualEntry(base64Data, "AI text capture failed.");
    }
});

function onScanSuccess(decodedText, imageBase64 = null) {
    // Prevent multiple scans of the same item in succession, or just stop
    stopScanner();
    showNotification(`Scanned: ${decodedText}`);
    recordScan(decodedText, imageBase64);
}

function onScanFailure(error) {
    // Expected during scanning process (not finding a code)
}

function openManualEntry(suggestedName = '') {
    readerContainer.classList.add('hidden');
    manualForm.classList.remove('hidden');
    packageNameInput.value = suggestedName;
    packageNameInput.focus();
}

function fallbackToManualEntry(imageBase64, message) {
    pendingImageBase64 = imageBase64;
    openManualEntry();
    showNotification(`${message} Enter the package name manually and the image will still be saved.`, "error");
}

function cleanDetectedName(value) {
    return value
        .replace(/^['"\s]+|['"\s]+$/g, '')
        .replace(/[\r\n]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

// API Functions
async function recordScan(packageName, imageBase64 = null) {
    showNotification(`Recording package: ${packageName}...`);
    try {
        const response = await fetch('/api/scan', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ packageName, imageBase64 })
        });
        
        const data = await response.json();
        if (response.ok) {
            showNotification(`Successfully recorded: ${packageName}`, "success");
            fetchScans(); // Refresh table
        } else {
            showNotification(data.error || "Failed to record entry.", "error");
        }
    } catch (error) {
        console.error("Network error:", error);
        showNotification("Network error. Is the server running?", "error");
    }
}

async function fetchScans() {
    try {
        const response = await fetch('/api/scans');
        if (!response.ok) return;
        
        const data = await response.json();
        
        if (data.length > 0) {
            noScansMsg.classList.add('hidden');
            scansList.innerHTML = '';
            
            data.forEach(scan => {
                if (scan.ai_description) {
                    aiCache[scan.id] = scan.ai_description;
                }
                const tr = document.createElement('tr');
                // Format date locally
                const dateObj = new Date(scan.scan_date);
                const dateStr = dateObj.toLocaleString();
                
                const imgCell = scan.image_path 
                    ? `<img src="${scan.image_path}" data-name="${escapeHtml(scan.package_name)}" class="scan-thumbnail" style="width: 50px; height: 50px; object-fit: cover; border-radius: 4px; cursor: pointer; transition: transform 0.2s;">` 
                    : '<span style="font-size:0.8rem; color: var(--text-muted)">No Image</span>';

                tr.innerHTML = `
                    <td data-label="ID">#${scan.id}</td>
                    <td data-label="Image">${imgCell}</td>
                    <td data-label="Name"><strong>${escapeHtml(scan.package_name)}</strong></td>
                    <td data-label="Date" class="text-muted">${dateStr}</td>
                    <td data-label="Actions">
                        <div style="display: flex; gap: 0.3rem; flex-wrap: wrap;">
                            <button class="btn primary-btn ai-info-btn" style="padding: 0.4rem 0.6rem; font-size: 0.8rem;" data-id="${scan.id}" data-name="${escapeHtml(scan.package_name)}">Ask AI</button>
                            <button class="btn outline-btn edit-btn" style="padding: 0.4rem 0.6rem; font-size: 0.8rem; border-color: rgba(255, 255, 255, 0.4);" data-id="${scan.id}" data-name="${escapeHtml(scan.package_name)}" data-date="${scan.scan_date}">Edit</button>
                            <button class="btn outline-btn delete-btn" style="padding: 0.4rem 0.6rem; font-size: 0.8rem; color: var(--error); border-color: rgba(239, 68, 68, 0.4);" data-id="${scan.id}">Delete</button>
                        </div>
                    </td>
                `;
                scansList.appendChild(tr);
            });

            // Bind AI info buttons
            document.querySelectorAll('.ai-info-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                   const scanId = e.target.getAttribute('data-id');
                   const pkgName = e.target.getAttribute('data-name');
                   fetchAIInfo(scanId, pkgName);
                });
            });

            // Bind Image Thumbnail clicks
            document.querySelectorAll('.scan-thumbnail').forEach(img => {
                img.addEventListener('click', (e) => {
                    const scanId = e.target.closest('tr')?.querySelector('.ai-info-btn')?.getAttribute('data-id');
                    const pkgName = e.target.getAttribute('data-name');
                    imageModalContent.src = e.target.src;
                    imageModalTitle.textContent = pkgName;
                    
                    if (scanId && aiCache[scanId]) {
                        imageModalInfo.textContent = aiCache[scanId];
                    } else {
                        imageModalInfo.textContent = "AI description not generated yet. Click 'Ask AI' in the table to fetch and store it.";
                    }

                    imageModal.classList.remove('hidden');
                    aiModalBackdrop.classList.remove('hidden');
                });
            });

            // Bind Delete buttons
            document.querySelectorAll('.delete-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    if (confirm('Are you sure you want to delete this scan entry?')) {
                        const id = e.target.getAttribute('data-id');
                        try {
                            const response = await fetch('/api/scans/' + id, {
                                method: 'DELETE'
                            });
                            const data = await response.json();
                            if (response.ok) {
                                showNotification("Scan deleted", "success");
                                fetchScans();
                            } else {
                                showNotification(data.error || "Failed to delete scan", "error");
                            }
                        } catch (err) {
                            showNotification("Network error while deleting", "error");
                        }
                    }
                });
            });

            // Bind Edit buttons
            document.querySelectorAll('.edit-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const id = e.target.getAttribute('data-id');
                    const name = e.target.getAttribute('data-name');
                    const dateStrOrig = e.target.getAttribute('data-date');
                    
                    editIdInput.value = id;
                    editPackageNameInput.value = name;
                    
                    // Format date for datetime-local input
                    const dateObj = new Date(dateStrOrig);
                    dateObj.setMinutes(dateObj.getMinutes() - dateObj.getTimezoneOffset());
                    editScanDateInput.value = dateObj.toISOString().slice(0, 16);
                    
                    editModal.classList.remove('hidden');
                    aiModalBackdrop.classList.remove('hidden');
                });
            });
        }
    } catch (error) {
        console.error("Error fetching scans:", error);
    }
}

async function fetchAIInfo(scanId, packageName) {
    if (scanId && aiCache[scanId]) {
        aiModalContent.textContent = aiCache[scanId];
        aiModalTitle.textContent = "Kimi Insights: " + packageName;
        aiModal.classList.remove('hidden');
        aiModalBackdrop.classList.remove('hidden');
        return;
    }

    aiModalTitle.textContent = "Analyzing " + packageName + "...";
    aiModalContent.textContent = "Kimi is pulling intelligence...";
    aiModal.classList.remove('hidden');
    aiModalBackdrop.classList.remove('hidden');

    try {
        const response = await fetch('/api/pesticide-info', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ packageName, scanId })
        });
        const data = await response.json();
        if (response.ok && data.info) {
            if (scanId) {
                aiCache[scanId] = data.info;
            }
            aiModalContent.textContent = data.info; 
            aiModalTitle.textContent = "Kimi Insights: " + packageName;
        } else {
            aiModalContent.textContent = "Error: " + (data.error || "Unknown");
        }
    } catch(err) {
        aiModalContent.textContent = "Network Error calling AI";
    }
}

// Modal handling
aiModalClose.addEventListener('click', () => {
    aiModal.classList.add('hidden');
    aiModalBackdrop.classList.add('hidden');
});

imageModalClose.addEventListener('click', () => {
    imageModal.classList.add('hidden');
    aiModalBackdrop.classList.add('hidden');
});

// Edit form handling
editForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = editIdInput.value;
    const packageName = editPackageNameInput.value.trim();
    const scanDate = editScanDateInput.value;
    
    try {
        const response = await fetch('/api/scans/' + id, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ packageName, scanDate })
        });
        const data = await response.json();
        if (response.ok) {
            showNotification("Scan updated successfully", "success");
            editModal.classList.add('hidden');
            aiModalBackdrop.classList.add('hidden');
            fetchScans();
        } else {
            showNotification(data.error || "Failed to update scan", "error");
        }
    } catch (err) {
        showNotification("Network error while updating", "error");
    }
});

editModalClose.addEventListener('click', () => {
    editModal.classList.add('hidden');
    aiModalBackdrop.classList.add('hidden');
});

// Utils
function showNotification(message, type = "success") {
    notification.textContent = message;
    notification.className = `notification show ${type}`;
    
    // Auto hide
    setTimeout(() => {
        notification.classList.remove('show');
    }, 4000);
}

function escapeHtml(unsafe) {
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
}
