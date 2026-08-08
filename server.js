const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const aibanto = require('./aibanto.js');

const app = express();
const PORT = process.env.PORT || 3000;

// Izinkan HTML mengakses API ini
app.use(cors());

// [BARU] Setup agar Node.js bisa menampilkan index.html ke publik
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Buat folder 'uploads' jika belum ada
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

// Konfigurasi Multer (Simpan file sementara ke Harddisk, BUKAN RAM)
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        // Beri nama unik agar tidak bentrok
        cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g, '_'));
    }
});
// Batas maksimal upload: 10GB
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 * 1024 } 
});

// Endpoint Utama: Terima video dan kembalikan hasil kompresi
app.post('/api/compress', upload.single('video'), (req, res) => {
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
            res.download(outputPath, `NanoCompressed_${req.file.originalname}`, (err) => {
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
app.post('/api/patch', upload.single('video'), (req, res) => {
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
        res.download(outputPath, `Patched_${req.file.originalname}`, (err) => {
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

app.listen(PORT, () => {
    console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
    console.log(`⚠️  PENTING: Pastikan program FFmpeg sudah terinstall di PC/OS Anda!`);
});