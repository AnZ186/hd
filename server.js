const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const aibanto = require('./aibanto.js');

// Pakai binary ffmpeg yang ikut terbundle di node_modules (tidak butuh apt install)
ffmpeg.setFfmpegPath(ffmpegPath);

// Nama file pendek & acak untuk file sementara di server (hindari nama kepanjangan)
function shortName() {
    return crypto.randomBytes(6).toString('hex');
}

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
        // Nama file pendek & acak untuk penyimpanan internal
        const ext = path.extname(file.originalname).toLowerCase().slice(0, 10);
        cb(null, Date.now() + '-' + shortName() + (ext || '.mp4'));
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

// =============================================================
// SISTEM JOB ASYNC
// Railway punya batas keras 300 detik per request di proxy.
// Upload + proses + download dalam SATU request bisa lewat batas itu.
// Jadi: upload balas cepat dengan jobId → proses jalan di background
// → client polling status → download hasil via request terpisah.
// =============================================================
const jobs = new Map();
const JOB_TTL_MS = 30 * 60 * 1000; // Job dibersihkan setelah 30 menit

function createJob(req, action) {
    const job = {
        id: shortName() + shortName(),
        action: action,
        status: 'queued',
        inputPath: req.file.path,
        outputPath: null,
        fileName: path.basename(req.file.originalname || 'video.mp4'),
        outputSize: 0,
        error: null,
        createdAt: Date.now(),
    };
    jobs.set(job.id, job);
    return job;
}

function cleanupJobFiles(job) {
    if (job.inputPath && fs.existsSync(job.inputPath)) fs.unlinkSync(job.inputPath);
    if (job.outputPath && fs.existsSync(job.outputPath)) fs.unlinkSync(job.outputPath);
}

// Pembersih berkala: buang job & file yang sudah basi
setInterval(() => {
    const now = Date.now();
    for (const [id, job] of jobs) {
        if (now - job.createdAt > JOB_TTL_MS) {
            cleanupJobFiles(job);
            jobs.delete(id);
        }
    }
}, 60 * 1000);

// Endpoint: Terima video, langsung balas jobId, proses di background
app.post('/api/compress', rateLimit, uploadWithLimits, (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Video tidak ditemukan' });
    }

    const job = createJob(req, 'compress');
    job.status = 'processing';
    res.json({ jobId: job.id });

    const outputPath = path.join(uploadDir, 'compressed_' + job.id + '.mp4');
    job.outputPath = outputPath;

    console.log(`[+] Job ${job.id}: Re-encode Lossless dimulai: ${job.fileName}`);

    // Proses Kompresi di background (tidak memblokir request upload)
    ffmpeg(job.inputPath)
        .outputOptions([
            "-vcodec libx264",     // Codec standar H.264
            "-crf 18",             // CRF 18 = Visually Lossless (Kualitas setara asli)
            "-preset slow",        // Algoritma lambat agar file ditekan semaksimal mungkin tanpa burik
            "-c:a copy"            // Audio stream di-copy mentah (tanpa re-encode, 100% ori)
        ])
        .save(outputPath)
        .on('end', () => {
            job.status = 'done';
            job.outputSize = fs.statSync(outputPath).size;
            if (fs.existsSync(job.inputPath)) fs.unlinkSync(job.inputPath);
            console.log(`[+] Job ${job.id}: Selesai (${job.outputSize} bytes).`);
        })
        .on('error', (err) => {
            job.status = 'failed';
            job.error = String(err.message || err);
            console.error(`[-] Job ${job.id}: Error Kompresi:`, err);
            cleanupJobFiles(job);
        });
});

// -------------------------------------------------------------
// [ENDPOINT BARU] /api/patch - Untuk modifikasi container MP4
// -------------------------------------------------------------
app.post('/api/patch', rateLimit, uploadWithLimits, (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Video tidak ditemukan' });
    }

    const job = createJob(req, 'patch');
    job.status = 'processing';
    res.json({ jobId: job.id });

    const outputPath = path.join(uploadDir, 'patched_' + job.id + '.mp4');
    job.outputPath = outputPath;

    console.log(`\n[+] Job ${job.id}: Proses PATCH dimulai: ${job.fileName}`);

    // Proses patch di background biar request upload balas cepat
    setImmediate(() => {
        try {
            // 1. Baca file video mentah sebagai Binary Buffer dari Harddisk
            const inputBuffer = fs.readFileSync(job.inputPath);

            // 2. Kirim Buffer tersebut ke dalam Aibanto Patcher logic
            const patchResult = aibanto.patchWithReport(inputBuffer, { branding: true });

            // 3. Simpan byte yang sudah dimodifikasi kembali ke Harddisk
            fs.writeFileSync(outputPath, patchResult.bytes);

            job.status = 'done';
            job.outputSize = fs.statSync(outputPath).size;
            if (fs.existsSync(job.inputPath)) fs.unlinkSync(job.inputPath);

            console.log(`[+] Job ${job.id}: Sukses nge-patch! (${job.outputSize} bytes)`);
            console.log(`    - Report Info: ${JSON.stringify(patchResult.report)}`);
        } catch (error) {
            job.status = 'failed';
            job.error = error.message;
            console.error(`[-] Job ${job.id}: Error saat patching:`, error);
            cleanupJobFiles(job);
        }
    });
});

// Cek status job (dipanggil client untuk polling)
app.get('/api/jobs/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) {
        return res.status(404).json({ error: 'Job tidak ditemukan (mungkin sudah kedaluwarsa).' });
    }
    res.json({
        id: job.id,
        action: job.action,
        status: job.status,
        fileName: job.fileName,
        outputSize: job.outputSize,
        error: job.error,
    });
});

// Download hasil job melalui request terpisah (anti timeout 5 menit proxy)
app.get('/api/download/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job || job.status !== 'done' || !job.outputPath || !fs.existsSync(job.outputPath)) {
        return res.status(404).json({ error: 'Hasil belum tersedia atau kedaluwarsa.' });
    }

    const prefix = job.action === 'compress' ? 'NanoCompressed' : 'Patched';
    const safeName = job.fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    res.download(job.outputPath, `${prefix}_${safeName}`, () => {
        cleanupJobFiles(job);
        jobs.delete(job.id);
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
    const outputPath = path.join(uploadDir, 'patched_' + shortName() + '.mp4');
    
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
    // Client membatalkan upload di tengah jalan (tab ditutup / koneksi putus).
    // Ini bukan kesalahan server — jangan balas 500, cukup bersihkan file.
    if (err.code === 'REQUEST_ABORTED' || (err.message && /aborted|closed/i.test(err.message))) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        console.log('[-] Upload dibatalkan client:', err.message);
        if (!res.headersSent) res.end();
        return;
    }
    console.error('[-] Unhandled error:', err);
    res.status(500).json({ error: 'Terjadi kesalahan pada server.' });
});

// GANTI BAGIAN PALING BAWAH INI:
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server berjalan di PORT: ${PORT}`);
    console.log(`⚠️  PENTING: Pastikan program FFmpeg sudah terinstall di server!`);
});

// Naikkan timeout bawaan Node supaya upload besar / proses ffmpeg lama tidak
// dianggap "Request aborted" oleh server. Node default requestTimeout = 5 menit.
server.headersTimeout = 0;
server.requestTimeout = 0;
server.keepAliveTimeout = 0;
server.setTimeout(0);
