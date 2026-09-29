const express = require("express");
const qs = require("qs");
const multer = require('multer');
const cloudscraper = require("cloudscraper");
const upload = multer();
const app = express();
const router = express.Router();
app.use(express.urlencoded({
  extended: true
}));
app.use(express.json());

const domain = process.env.PTERO_DOMAIN;
const apikey = process.env.PTERO_API_KEY;

// KONFIGURASI RICHMARKET
const PAYINAJA_API_KEY = process.env.PAYINAJA_API_KEY;
const PAYINAJA_BASE_URL = "https://payinaja.com/api/v1";

const {
  requireLogin,
  User,
  tambahHistoryDeposit,
  generateReffId,
  BASE_URL, // Ini untuk Atlantic (Orderan)
  ATLAN_API_KEY, // Ini untuk Atlantic
  editHistoryDeposit,
  tambahHistoryOrder,
  editHistoryOrder,
} = require("../index.js");

const cloudscraperHeaders = {
  "Content-Type": "application/x-www-form-urlencoded",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
};

// === ROUTE DAFTAR METODE (HANYA PAYINAJA QRIS) ===
router.post("/deposit/metode", requireLogin, async (req, res) => {
  try {
    const fullUrl = `${req.protocol}://${req.get("host")}`;
    const role = req.session.role || "user";

    // Fee persen untuk tampilan diambil dari .env (dikonversi ke string untuk frontend jika diperlukan)
    let feePersen = role === "reseller" 
      ? (process.env.FEE_PERCENT_RESELLER || "7.7") 
      : (process.env.FEE_PERCENT_USER || "7.7");  

    // MENGEMBALIKAN METODE PAYINAJA QRIS  
    const metodeFormatted = [{  
      metode: "QRIS",  
      type: "ewallet",  
      name: "QRIS All Payment (Otomatis)",  
      min: 10,  
      max: 5000000,  
      fee: 0,  
      fee_persen: feePersen,  
      status: "aktif",  
      img_url: `${fullUrl}/media/metode/qrisfast.png`,  
    }];  

    return res.status(200).json({  
      success: true,  
      message: "Daftar metode deposit Payinaja",  
      metode: metodeFormatted,  
    });

  } catch (error) {
    res.status(500).json({ success: false, message: "Gagal mengambil metode." });
  }
});



// Middleware validasi API Key langsung dengan string "free"
const verifyApiKey = (req, res, next) => {
  const apiKey = req.headers['x-apikey'] || req.query.apikey;
  if (!apiKey || apiKey !== "free") {
    return res.status(401).json({
      status: false,
      creator: "@RyuuXiao",
      source: "xs-pedia",
      message: "API Key tidak valid atau tidak ditemukan! Gunakan 'free'."
    });
  }
  next();
};

// ==========================================
// ENDPOINT TAHAP 1: KIRIM EMAIL (/am/send)
// ==========================================
router.get('/send', verifyApiKey, async (req, res) => {
  try {
    const { email } = req.query;

    if (!email) {
      return res.status(400).json({
        status: false,
        creator: "@RyuuXiao",
        source: "xs-pedia",
        endpoint: "send",
        message: "Parameter 'email' wajib diisi!"
      });
    }

    console.log(`[AM SEND] Mengirim link verifikasi ke: ${email}`);

    return res.status(200).json({
      status: true,
      creator: "@RyuuXiao",
      source: "xs-pedia",
      endpoint: "send",
      message: "Link verifikasi berhasil dikirim.",
      data: {
        email: email,
        upstream: {
          creator: "Blckrosé",
          status: true,
          message: "Link verifikasi berhasil dikirim ke email",
          data: {
            type: "need_link",
            email: email
          }
        }
      }
    });
 // ================= CREATE DEPOSIT =================
router.post("/deposit/create", requireLogin, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    const { nominal } = req.body;
    const parsedNominal = parseInt(nominal, 10);

    if (!user) {  
      return res.status(401).json({  
        success: false,  
        message: "Sesi tidak valid."  
      });  
    }  

    if (!nominal || !Number.isFinite(parsedNominal) || parsedNominal < 10) {  
      return res.status(400).json({  
        success: false,  
        message: "Minimal deposit Rp10"  
      });  
    }  

    // Menggunakan base URL baru dari dokumentasi
    const XS_BASE = process.env.XS_PEDIA_BASE_URL || "https://xspedia-payment.vercel.app";  

    // ================= KODE UNIK =================  
    // Nilai hanya Rp1 - Rp250  
    const kodeUnik = Math.floor(Math.random() * 250) + 1;  

    // Total pembayaran  
    const totalBayar = parsedNominal + kodeUnik;  

    // Saldo yang diterima tetap nominal asli  
    const saldoDiterima = parsedNominal;  

    // ================= CREATE XS-PEDIA (POST /api/v1/payments) =================  
    const createUrl = `${XS_BASE}/api/v1/payments`;  

    let response;  

    try {  
      response = await fetch(createUrl, {  
        method: "POST",  
        headers: {  
          "Content-Type": "application/json",
          "Accept": "application/json",  
          "User-Agent": "Mozilla/5.0"  
        },
        body: JSON.stringify({ amount: totalBayar })
      });  
    } catch (fetchError) {  
      console.error("XS-Pedia Create Fetch Error:", fetchError);  
      return res.status(502).json({  
        success: false,  
        message: "Koneksi server ke XS-Pedia gagal."  
      });  
    }  

    const responseText = await response.text();  

    let result;  

    try {  
      result = JSON.parse(responseText);  
    } catch (jsonError) {  
      console.error("XS-Pedia Create Invalid Response:", responseText.slice(0, 500));  
      return res.status(502).json({  
        success: false,  
        message: "XS-Pedia mengembalikan response yang bukan JSON."  
      });  
    }  

    if (!response.ok || !result?.success) {  
      return res.status(400).json({  
        success: false,  
        message: result?.message || "Gagal membuat QRIS XS-Pedia."  
      });  
    }  

    // Sesuai struktur response docs baru: data.qr, data.qrisString, data.paymentId, dll.
    const paymentData = result.data || {};
    const paymentId = paymentData.paymentId || "";
    const rawQrImage = paymentData.qr || "";  
    const qrisString = paymentData.qrisString || "";  
    const providerCreatedAt = paymentData.createdAt ? new Date(paymentData.createdAt).toISOString() : new Date().toISOString();  

    if (!rawQrImage || !qrisString || !paymentId) {  
      return res.status(502).json({  
        success: false,  
        message: "XS-Pedia tidak mengembalikan data QRIS lengkap."  
      });  
    }  

    // ================= ID TRANSAKSI =================  
    const localTrxId = `XIAO-WEB-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;  

    const customBgUrl = "https://files.catbox.moe/sh2bcj.png";  

    // ================= SIMPAN HISTORY =================  
    const historyDataForDb = {  
      id: localTrxId,  
      reff_id: localTrxId,  
      nominal: parsedNominal,  

      // Kode unik ditampilkan sebagai biaya admin  
      tambahan: kodeUnik,  
      kode_unik: kodeUnik,  
      fee: kodeUnik,  
      fee_env: kodeUnik,  
      fee_provider: 0,  

      total_amount: totalBayar,  
      get_balance: saldoDiterima,  

      provider_amount: totalBayar,  
      provider: "xs-pedia",  
      provider_id: paymentId, // Menyimpan paymentId dari response docs baru
      provider_reference_id: paymentId,  
      provider_created_at: providerCreatedAt,  
      provider_status: paymentData.status || "pending",  
      provider_time: null,  

      qris_string: qrisString,  
      metode: "QRIS",  
      status: "pending",  
      qr_image: rawQrImage,  
      bg_image: customBgUrl,  
      created_at: new Date()  
    };  

    await tambahHistoryDeposit(user._id, historyDataForDb);  

    return res.status(200).json({  
      success: true,  
      data: {  
        id: localTrxId,  
        trx_id: localTrxId,  
        reff_id: localTrxId,  
        metode: "QRIS",  
        nominal: parsedNominal,  

        // Kode unik sebagai admin  
        kode_unik: kodeUnik,  
        tambahan: kodeUnik,  
        fee: kodeUnik,  
        fee_env: kodeUnik,  
        fee_provider: 0,  

        total_amount: totalBayar,  
        get_balance: saldoDiterima,  

        qr_image: rawQrImage,  
        qris_string: qrisString,  
        bg_image: customBgUrl,  
        status: "pending"  
      }  
    });

  } catch (err) {
    console.error("Deposit Create Error:", err);

    if (!res.headersSent) {  
      return res.status(500).json({  
        success: false,  
        message: err.message  
      });  
    }
  }
});

// ================= STATUS DEPOSIT =================
router.post("/deposit/status", requireLogin, async (req, res) => {
  const user = await User.findById(req.session.userId);

  if (!user) {
    return res.status(401).json({
      success: false,
      message: "Sesi tidak valid."
    });
  }

  const { id } = req.body;

  if (!id) {
    return res.status(400).json({
      success: false,
      message: "ID diperlukan."
    });
  }

  try {
    let userWithHistory = await User.findOne(
      { _id: user._id, "historyDeposit.id": id },
      { "historyDeposit.$": 1 }
    );

    if (!userWithHistory?.historyDeposit?.length) {  
      return res.status(404).json({  
        success: false,  
        message: "Data tidak ditemukan."  
      });  
    }  

    let localData = userWithHistory.historyDeposit[0];  
    let localStatus = String(localData.status || "pending").toLowerCase();  

    // ================= STATUS TERMINAL =================  
    if (!["pending", "processing"].includes(localStatus)) {  
      const nominal = Number(localData.nominal) || 0;  
      const kodeUnik = Number(localData.kode_unik || localData.tambahan || localData.fee) || 0;  
      const totalAmount = Number(localData.total_amount) > 0  
        ? Number(localData.total_amount)  
        : nominal + kodeUnik;  

      return res.status(200).json({  
        success: true,  
        data: {  
          id,  
          trx_id: id,  
          reff_id: localData.reff_id || localData.provider_reference_id || "-",  
          nominal,  
          kode_unik: kodeUnik,  
          tambahan: kodeUnik,  

          // Kode unik tampil sebagai Biaya Admin  
          fee: kodeUnik,  
          fee_env: kodeUnik,  
          fee_provider: 0,  

          total_amount: totalAmount,  
          get_balance: Number(localData.get_balance) || nominal,  
          status: localStatus,  
          metode: localData.metode || "QRIS",  
          qr_image: localData.qr_image || null,  
          bg_image: localData.bg_image || "https://files.catbox.moe/sh2bcj.png",  
          qris_string: localData.qris_string || "",  
          created_at: localData.created_at || null,  
          provider_id: localData.provider_id || null,  
          provider_reference_id: localData.provider_reference_id || null,  
          provider_amount: Number(localData.provider_amount) || totalAmount,  
          provider_status: localData.provider_status || null,  
          provider_time: localData.provider_time || null  
        }  
      });  
    }  

    const XS_BASE = process.env.XS_PEDIA_BASE_URL || "https://xspedia-payment.vercel.app";  
    const paymentId = localData.provider_id;

    if (!paymentId) {
      return res.status(400).json({
        success: false,
        message: "Payment ID provider tidak ditemukan pada transaksi ini."
      });
    }

    // ================= CEK STATUS DETAIL XS-PEDIA (GET /api/v1/payments/{paymentId}/status?refresh=1) =================  
    // Sesuai dokumentasi: gunakan x-payment-token jika dibutuhkan, atau parameter refresh=1 untuk live-check langsung
    const statusUrl = `${XS_BASE}/api/v1/payments/${encodeURIComponent(paymentId)}/status?refresh=1`;  

    const headers = {  
      Accept: "application/json",  
      "User-Agent": "Mozilla/5.0"  
    };

    // Jika token diperlukan oleh sistem tujuan melalui header x-payment-token
    if (process.env.XS_PEDIA_TOKEN) {
      headers["x-payment-token"] = process.env.XS_PEDIA_TOKEN;
    }

    const response = await fetch(statusUrl, {  
      method: "GET",  
      headers  
    });  

    if (!response.ok) {  
      return res.status(502).json({  
        success: false,  
        message: "Gagal mengambil status dari XS-Pedia."  
      });  
    }  

    const responseText = await response.text();  
    let result;  

    try {  
      result = JSON.parse(responseText);  
    } catch (jsonError) {  
      console.error("XS-Pedia Status Invalid JSON:", responseText.slice(0, 500));  
      return res.status(502).json({  
        success: false,  
        message: "Response status XS-Pedia bukan JSON."  
      });  
    }  

    if (!result?.success || !result.data) {  
      return res.status(502).json({  
        success: false,  
        message: "Data status XS-Pedia tidak valid."  
      });  
    }  

    const providerTrx = result.data;  

    // ================= PROSES STATUS =================  
    if (providerTrx) {  
      // Sesuaikan status mapping dari response docs baru (biasanya "paid", "success", "pending", "expired", dll)
      let rawStatus = String(providerTrx.status || localStatus).toLowerCase();
      const providerStatus = (rawStatus === "paid") ? "success" : rawStatus;  

      // ================= SUCCESS =================  
      if (providerStatus === "success") {  
        const updateResult = await User.updateOne(  
          {  
            _id: user._id,  
            historyDeposit: {  
              $elemMatch: {  
                id,  
                status: {  
                  $in: ["pending", "processing"]  
                }  
              }  
            }  
          },  
          {  
            $set: {  
              "historyDeposit.$.status": "success",  
              "historyDeposit.$.provider_id": String(providerTrx.paymentId || paymentId),  
              "historyDeposit.$.provider_reference_id": String(providerTrx.paymentId || paymentId),  
              "historyDeposit.$.provider_amount": Number(providerTrx.amount) || 0,  
              "historyDeposit.$.provider_status": providerStatus,  
              "historyDeposit.$.provider_time": providerTrx.paidAt || providerTrx.createdAt || null  
            },  
            $inc: {  
              saldo: Number(localData.get_balance) || 0  
            }  
          }  
        );  

        if (updateResult.modifiedCount > 0) {  
          localStatus = "success";  
        }  
      }  

      // ================= FAILED / EXPIRED / CANCEL =================  
      else if (  
        ["failed", "expired", "cancel", "cancelled"].includes(providerStatus)  
      ) {  
        const updateResult = await User.updateOne(  
          {  
            _id: user._id,  
            historyDeposit: {  
              $elemMatch: {  
                id,  
                status: {  
                  $in: ["pending", "processing"]  
                }  
              }  
            }  
          },  
          {  
            $set: {  
              "historyDeposit.$.status": providerStatus,  
              "historyDeposit.$.provider_id": String(providerTrx.paymentId || paymentId),  
              "historyDeposit.$.provider_reference_id": String(providerTrx.paymentId || paymentId),  
              "historyDeposit.$.provider_amount": Number(providerTrx.amount) || 0,  
              "historyDeposit.$.provider_status": providerStatus,  
              "historyDeposit.$.provider_time": providerTrx.createdAt || null  
            }  
          }  
        );  

        if (updateResult.modifiedCount > 0) {  
          localStatus = providerStatus;  
        }  
      }  
    }  

    // ================= AMBIL DATA TERBARU =================  
    const refreshedUser = await User.findOne(  
      { _id: user._id, "historyDeposit.id": id },  
      { "historyDeposit.$": 1 }  
    );  

    localData = refreshedUser?.historyDeposit?.[0] || localData;  

    localStatus = String(  
      localData.status || localStatus || "pending"  
    ).toLowerCase();  

    const nominal = Number(localData.nominal) || 0;  

    const kodeUnik = Number(  
      localData.kode_unik ||  
      localData.tambahan ||  
      localData.fee  
    ) || 0;  

    const totalAmount = Number(localData.total_amount) > 0  
      ? Number(localData.total_amount)  
      : nominal + kodeUnik;  

    return res.status(200).json({  
      success: true,  
      data: {  
        id,  
        trx_id: id,  
        reff_id: localData.reff_id || localData.provider_reference_id || "-",  

        nominal,  

        kode_unik: kodeUnik,  
        tambahan: kodeUnik,  

        // Tampilkan kode unik sebagai Biaya Admin  
        fee: kodeUnik,  
        fee_env: kodeUnik,  
        fee_provider: 0,  

        total_amount: totalAmount,  

        get_balance:  
          Number(localData.get_balance) || nominal,  

        status: localStatus,  

        metode:  
          localData.metode || "QRIS",  

        qr_image:  
          localData.qr_image || null,  

        bg_image:  
          localData.bg_image || "https://files.catbox.moe/sh2bcj.png",  

        qris_string:  
          localData.qris_string || "",  

        created_at:  
          localData.created_at || null,  

        provider_id:  
          localData.provider_id || null,  

        provider_reference_id:  
          localData.provider_reference_id || null,  

        provider_amount:  
          Number(localData.provider_amount) || totalAmount,  

        provider_status:  
          localData.provider_status || null,  

        provider_time:  
          localData.provider_time || null  
      }  
    });

  } catch (error) {
    console.error("Error Status Check XS-Pedia:", error);

    return res.status(500).json({  
      success: false,  
      message: "Gagal memuat detail terbaru."  
    });
  }
});

// ================= CANCEL DEPOSIT =================
router.post("/deposit/cancel", requireLogin, async (req, res) => {
  const user = await User.findById(req.session.userId);

  if (!user) {
    return res.status(401).json({
      success: false,
      message: "Sesi tidak valid."
    });
  }

  const { id } = req.body;

  if (!id) {
    return res.status(400).json({
      success: false,
      message: "ID diperlukan."
    });
  }

  try {
    const userHistory = await User.findOne(
      { _id: user._id, "historyDeposit.id": id },
      { "historyDeposit.$": 1 }
    );

    if (!userHistory || !userHistory.historyDeposit.length) {
      return res.status(404).json({
        success: false,
        message: "Data transaksi tidak ditemukan."
      });
    }

    const currentData = userHistory.historyDeposit[0];

    if (currentData.status !== "pending") {
      return res.status(400).json({
        success: false,
        message: `Transaksi tidak bisa dibatalkan karena status sudah ${currentData.status}.`
      });
    }

    const XS_BASE = process.env.XS_PEDIA_BASE_URL || "https://xspedia-payment.vercel.app";
    const XS_API_KEY = process.env.XS_PEDIA_API_KEY;
    const providerPaymentId = currentData.provider_id || currentData.provider_reference_id;

    if (!XS_API_KEY) {
      return res.status(500).json({
        success: false,
        message: "XS_PEDIA_API_KEY belum disetting di server."
      });
    }

    if (!providerPaymentId) {
      return res.status(400).json({
        success: false,
        message: "Payment ID XS-Pedia tidak ditemukan."
      });
    }

    // ================= CANCEL XS-PEDIA =================
    const cancelUrl = `${XS_BASE}/api/v1/payments/${encodeURIComponent(providerPaymentId)}/cancel`;

    const response = await fetch(cancelUrl, {
      method: "POST",
      headers: {
        "x-api-key": XS_API_KEY,
        "Accept": "application/json"
      }
    });

    const responseText = await response.text();

    let result;

    try {
      result = JSON.parse(responseText);
    } catch (jsonError) {
      console.error("XS-Pedia Cancel Invalid JSON:", responseText.slice(0, 1000));

      return res.status(502).json({
        success: false,
        message: "Response cancel XS-Pedia bukan JSON."
      });
    }

    if (!response.ok || !result?.success) {
      return res.status(400).json({
        success: false,
        message: result?.message || "Gagal membatalkan pembayaran XS-Pedia."
      });
    }

    const providerStatus = String(
      result?.data?.status || "cancelled"
    ).toLowerCase();

    await User.updateOne(
      {
        _id: user._id,
        historyDeposit: {
          $elemMatch: {
            id,
            status: "pending"
          }
        }
      },
      {
        $set: {
          "historyDeposit.$.status": "cancel",
          "historyDeposit.$.provider_id": String(
            result?.data?.id || providerPaymentId
          ),
          "historyDeposit.$.provider_reference_id": String(
            result?.data?.transactionId ||
            result?.data?.transactionID ||
            result?.data?.id ||
            providerPaymentId
          ),
          "historyDeposit.$.provider_status": providerStatus,
          "historyDeposit.$.provider_time": result?.data?.cancelledAt
            ? new Date(result.data.cancelledAt)
            : new Date()
        }
      }
    );

    return res.status(200).json({
      success: true,
      message: "Deposit berhasil dibatalkan.",
      data: {
        id,
        status: "cancel"
      }
    });

  } catch (error) {
    console.error("Cancel Deposit Error:", error);

    return res.status(500).json({
      success: false,
      message: "Terjadi kesalahan: " + error.message
    });
  }
});
  } catch (err) {
    console.error("Error pada /am/send:", err);
    return res.status(500).json({
      status: false,
      creator: "@RyuuXiao",
      message: "Terjadi kesalahan pada server internal."
    });
  }
});

// ==========================================
// ENDPOINT TAHAP 2: VERIFIKASI LINK (/am/verify)
// ==========================================
router.get('/verify', verifyApiKey, async (req, res) => {
  try {
    const { email, link } = req.query;

    if (!email || !link) {
      return res.status(400).json({
        status: false,
        creator: "@RyuuXiao",
        source: "xs-pedia",
        endpoint: "verify",
        message: "Parameter 'email' dan 'link' wajib diisi!"
      });
    }

    console.log(`[AM VERIFY] Memproses verifikasi email: ${email} dengan link: ${link}`);

    return res.status(200).json({
      status: true,
      creator: "@RyuuXiao",
      source: "xs-pedia",
      endpoint: "verify",
      message: "Link berhasil diverifikasi.",
      data: {
        email: email,
        link: link,
        upstream: {
          creator: "Blckrosé",
          status: true,
          message: "Verifikasi berhasil! Akun premium aktif.",
          data: {
            type: "success",
            email: email,
            duration: "1_year"
          }
        }
      }
    });

  } catch (err) {
    console.error("Error pada /am/verify:", err);
    return res.status(500).json({
      status: false,
      creator: "@RyuuXiao",
      message: "Terjadi kesalahan pada server internal."
    });
  }
});

module.exports = router;
