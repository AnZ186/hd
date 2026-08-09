const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');

const aibanto = require('./aibanto.js');

const app = express();
const PORT = process.env.PORT || 3000;

// TIDAK pakai express.static(__dirname) — itu mengekspos seluruh direktori
// (server.js, aibanto.js, package.json, folder uploads/) ke publik di Railway.
// Hanya index.html yang disajikan eksplisit di rute; API & sisanya tidak.

app.get(['/', '/index.html'], (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'), (err) => {
        if (err) res.status(500).send('Gagal memuat index.html');
    });
});

app.get('/favicon.ico', (req, res) => res.status(204).end());

// Buat folder 'uploads' jika belum ada
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

// Ekstensi video yang diperbolehkan (anti penyisipan file berbahaya)
const ALLOWED_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.m4v', '.avi', '.mkv']);

// Konfigurasi Multer (Simpan file sementara ke Harddisk, BUKAN RAM)
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        // Sanitasi nama file: hilangkan path traversal ("../", "..\\") & karakter berbahaya
        const safeBase = path.basename(file.originalname)
            .replace(/\.\.+/g, '')
            .replace(/[^a-zA-Z0-9._-]/g, '_')
            .slice(0, 100);
        cb(null, Date.now() + '-' + (safeBase || 'video'));
    }
});

// Validator tipe file: hanya video yang diperbolehkan
const fileFilter = (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const mimeOk = file.mimetype
        ? file.mimetype.startsWith('video/') || file.mimetype === 'application/octet-stream'
        : true;
    if (ALLOWED_EXTENSIONS.has(ext) && mimeOk) {
        cb(null, true);
    } else {
        cb(new Error('Tipe file tidak diizinkan. Hanya video (MP4, WEBM, MOV, dll).'));
    }
};

// Batas upload berdasarkan akses:
// - Tamu (tanpa token): maks 50MB
// - Owner (token valid): maks 10GB
const GUEST_MAX_SIZE = 50 * 1024 * 1024;
const OWNER_MAX_SIZE = 10 * 1024 * 1024 * 1024;

const guestUpload = multer({
    storage: storage,
    limits: { fileSize: GUEST_MAX_SIZE },
    fileFilter: fileFilter
});

const ownerUpload = multer({
    storage: storage,
    limits: { fileSize: OWNER_MAX_SIZE },
    fileFilter: fileFilter
});

// Cek apakah request datang dari owner (token valid dari env OWNER_TOKEN)
function isOwner(req) {
    const header = req.headers['x-auth-token'] || '';
    const bearer = req.headers.authorization || '';
    const token = header || (bearer.startsWith('Bearer ') ? bearer.slice(7) : '');
    return !!process.env.OWNER_TOKEN && token === process.env.OWNER_TOKEN;
}

// Pilih multer sesuai level akses request ini
function uploadWithLimits(req, res, next) {
    const upload = isOwner(req) ? ownerUpload : guestUpload;
    upload.single('video')(req, res, next);
}

// Rate limiter sederhana (in-memory, per IP per menit)
// Owner: 30 request/menit · Tamu: 5 request/menit
const rateHits = new Map();
function rateLimit(req, res, next) {
    const owner = isOwner(req);
    const limit = owner ? 30 : 5;
    const windowMs = 60 * 1000;
    const key = (owner ? 'owner:' : 'guest:') + req.ip;
    const now = Date.now();

    let hits = (rateHits.get(key) || []).filter((t) => t > now - windowMs);
    if (hits.length >= limit) {
        return res.status(429).json({
            error: owner ? 'Terlalu banyak permintaan. Coba lagi sebentar.' : 'Limit pemakaian tamu tercapai. Coba lagi dalam 1 menit.'
        });
    }
    hits.push(now);
    rateHits.set(key, hits);

    // Bersihkan bucket lama agar map tidak membengkak
    if (Math.random() < 0.01) {
        for (const [k, arr] of rateHits) {
            const fresh = arr.filter((t) => t > now - windowMs);
            if (fresh.length) rateHits.set(k, fresh);
            else rateHits.delete(k);
        }
    }
    next();
}

// Endpoint Utama: Terima video dan kembalikan hasil kompresi
app.post('/api/compress', rateLimit, uploadWithLimits, (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Video tidak ditemukan' });
    }

    const inputPath = req.file.path;
    const outputPath = path.join(uploadDir, 'compressed_' + req.file.filename);
    
    // Ambil level kompresi dari request (Default CRF 28)
    const crfValue = req.body.compression || '28';

    console.log(`[+] Memulai re-encode Lossless: ${req.file.originalname}`);

    // Proses Kompresi menggunakan FFmpeg
    ffmpeg(inputPath)
        .outputOptions([
            "-vcodec libx264",     // Codec standar H.264
            "-crf 18",             // CRF 18 = Visually Lossless (Kualitas setara asli)
            "-preset slow",        // Algoritma lambat agar file ditekan semaksimal mungkin tanpa burik
            "-c:a copy"            // Audio stream di-copy mentah (tanpa re-encode, 100% ori)
            
            // Catatan: Baris "-vf scale..." sengaja saya hapus agar resolusi (misal 4K/2K) tetap dipertahankan.
        ])
        .save(outputPath)
        .on('end', () => {
            console.log(`[+] Selesai: ${req.file.originalname}. Mengirim ke client...`);
            
            // Kirim file hasil kompresi ke browser untuk didownload
            const safeName = path.basename(req.file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
            res.download(outputPath, `NanoCompressed_${safeName}`, (err) => {
                // Bersihkan file dari harddisk setelah selesai di-download (Hemat Ruang)
                if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
                if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
            });
        })
        .on('error', (err) => {
            console.error('[-] Error Kompresi:', err);
            if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
            res.status(500).json({ error: 'Gagal mengkompres video.' });
        });
});

// -------------------------------------------------------------
// [ENDPOINT BARU] /api/patch - Untuk modifikasi container MP4
// -------------------------------------------------------------
app.post('/api/patch', rateLimit, uploadWithLimits, (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Video tidak ditemukan' });
    }

    const inputPath = req.file.path;
    const outputPath = path.join(uploadDir, 'patched_' + req.file.filename);
    
    console.log(`\n[+] Memulai proses PATCH: ${req.file.originalname}`);

    try {
        // 1. Baca file video mentah sebagai Binary Buffer dari Harddisk
        const inputBuffer = fs.readFileSync(inputPath);
        
        // 2. Kirim Buffer tersebut ke dalam Aibanto Patcher logic
        const patchResult = aibanto.patchWithReport(inputBuffer, { branding: true });
        
        // 3. Simpan byte yang sudah dimodifikasi kembali ke Harddisk
        fs.writeFileSync(outputPath, patchResult.bytes);
        
        console.log(`[+] Sukses nge-patch! Mengirim ke client...`);
        console.log(`    - Report Info: ${JSON.stringify(patchResult.report)}`);

        // 4. Kirim file hasil patch ke user untuk didownload
        const safeName = path.basename(req.file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
        res.download(outputPath, `Patched_${safeName}`, (err) => {
            // 5. Bersihkan file sampah (Input dan Output) setelah selesai
            if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        });
    } catch (error) {
        console.error('[-] Error saat patching:', error);
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        res.status(500).json({ error: 'Gagal mempatch video: ' + error.message });
    }
});

// Handler error global: tangkap error dari Multer (file terlalu besar / tipe tidak valid)
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            const limit = isOwner(req) ? '10GB' : '50MB';
            return res.status(400).json({ error: `File terlalu besar. Maksimum upload ${limit}${isOwner(req) ? '' : ' (token owner untuk lebih besar)'}.` });
        }
        return res.status(400).json({ error: err.message });
    }
    if (err.message && err.message.includes('Tipe file tidak diizinkan')) {
        return res.status(400).json({ error: err.message });
    }
    console.error('[-] Unhandled error:', err);
    res.status(500).json({ error: 'Terjadi kesalahan pada server.' });
});

// GANTI BAGIAN PALING BAWAH INI:
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server berjalan di PORT: ${PORT}`);
    console.log(`⚠️  PENTING: Pastikan program FFmpeg sudah terinstall di server!`);
});
