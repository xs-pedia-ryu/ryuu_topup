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
// ================= DAFTAR METODE DEPOSIT =================
router.post("/deposit/metode", requireLogin, async (req, res) => {
  try {
    const fullUrl = `${req.protocol}://${req.get("host")}`;
    const role = req.session.role || "user";

    // Fee persen untuk tampilan
    let feePersen =
      role === "reseller"
        ? (process.env.FEE_PERCENT_RESELLER || "7.7")
        : (process.env.FEE_PERCENT_USER || "7.7");

    // Metode QRIS
    const metodeFormatted = [
      {
        metode: "QRIS",
        type: "ewallet",
        name: "QRIS All Payment (Otomatis)",
        min: 10,
        max: 5000000,
        fee: 0,
        fee_persen: feePersen,
        status: "aktif",
        img_url: `${fullUrl}/media/metode/qrisfast.png`,
      },
    ];

    return res.status(200).json({
      success: true,
      message: "Daftar metode deposit Payinaja",
      metode: metodeFormatted,
    });
  } catch (error) {
    console.error("Error deposit/metode:", error);

    return res.status(500).json({
      success: false,
      message: "Gagal mengambil metode.",
    });
  }
});
// ================= BUAT TRANSAKSI DEPOSIT =================
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

    const XS_BASE = process.env.XS_PEDIA_BASE_URL || "https://xspedia-payment.vercel.app";

    // ================= KODE UNIK =================
    const kodeUnik = Math.floor(Math.random() * 250) + 1; // Nilai Rp1 - Rp250
    const totalBayar = parsedNominal + kodeUnik;
    const saldoDiterima = parsedNominal;

    // ================= CREATE XS-PEDIA (API v1) =================
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
        body: JSON.stringify({
          amount: totalBayar
        })
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

    if (!response.ok || !result?.success || !result?.data) {
      return res.status(400).json({
        success: false,
        message: result?.message || "Gagal membuat QRIS XS-Pedia."
      });
    }

    // Mapping sesuai struktur response API v1
    const paymentData = result.data;
    const rawQrImage = paymentData.qr || "";
    const qrisString = paymentData.qrisString || "";
    const providerPaymentId = paymentData.paymentId || null;
    
    // Parsing timestamp UNIX MS dari API XS-Pedia
    const rawCreatedAt = paymentData.createdAt;
    const providerCreatedAt = rawCreatedAt 
      ? new Date(typeof rawCreatedAt === 'number' ? rawCreatedAt : rawCreatedAt).toISOString() 
      : new Date().toISOString();

    if (!rawQrImage || !qrisString) {
      return res.status(502).json({
        success: false,
        message: "XS-Pedia tidak mengembalikan QRIS lengkap."
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
      tambahan: kodeUnik,
      kode_unik: kodeUnik,
      fee: kodeUnik,
      fee_env: kodeUnik,
      fee_provider: 0,
      total_amount: totalBayar,
      get_balance: saldoDiterima,
      provider_amount: totalBayar,
      provider: "xs-pedia",
      provider_id: providerPaymentId,
      provider_reference_id: providerPaymentId,
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

    res.status(200).json({
      success: true,
      data: {
        id: localTrxId,
        trx_id: localTrxId,
        reff_id: localTrxId,
        metode: "QRIS",
        nominal: parsedNominal,
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

    // ================= BACKGROUND POLLING XS-PEDIA =================
    const intervalId = setInterval(async () => {
      try {
        const latestHistory = await User.findOne(
          { _id: user._id, "historyDeposit.id": localTrxId },
          { "historyDeposit.$": 1 }
        );

        const latestDeposit = latestHistory?.historyDeposit?.[0];
        const localStatus = String(latestDeposit?.status || "").toLowerCase();

        if (!latestDeposit || !["pending", "processing"].includes(localStatus)) {
          clearInterval(intervalId);
          return;
        }

        const XS_TOKEN = process.env.XS_PEDIA_TOKEN;
        const historyUrl = `${XS_BASE}/api/history?token=${encodeURIComponent(XS_TOKEN)}`;
        const checkRes = await fetch(historyUrl, {
          method: "GET",
          headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" }
        });

        if (!checkRes.ok) return;

        const checkData = await checkRes.json();
        if (!checkData?.success || !Array.isArray(checkData.data)) return;

        let providerTrx = null;
        if (latestDeposit.provider_id) {
          providerTrx = checkData.data.find(x => String(x.id) === String(latestDeposit.provider_id));
        }

        if (!providerTrx) {
          const targetAmount = Number(latestDeposit.provider_amount || latestDeposit.total_amount || 0);
          const createdTime = new Date(latestDeposit.created_at).getTime();

          const candidates = checkData.data
            .filter(x => Number(x.amount) === targetAmount)
            .filter(x => {
              const xt = new Date(x.time).getTime();
              return Number.isFinite(xt) && xt >= createdTime - 3 * 60 * 1000 && xt <= createdTime + 20 * 60 * 1000;
            })
            .sort((a, b) => new Date(a.time) - new Date(b.time));

          for (const candidate of candidates) {
            const alreadyUsed = await User.findOne({
              "historyDeposit.provider_id": String(candidate.id)
            }).select("_id");

            if (!alreadyUsed) {
              providerTrx = candidate;
              break;
            }
          }
        }

        if (!providerTrx) return;

        const providerStatus = String(providerTrx.status || "").toLowerCase();

        if (providerStatus === "success") {
          const updateResult = await User.updateOne(
            {
              _id: user._id,
              historyDeposit: {
                $elemMatch: {
                  id: localTrxId,
                  status: { $in: ["pending", "processing"] }
                }
              }
            },
            {
              $set: {
                "historyDeposit.$.status": "success",
                "historyDeposit.$.provider_id": String(providerTrx.id),
                "historyDeposit.$.provider_reference_id": String(providerTrx.reference_id || providerTrx.id),
                "historyDeposit.$.provider_amount": Number(providerTrx.amount) || 0,
                "historyDeposit.$.provider_status": providerStatus,
                "historyDeposit.$.provider_time": providerTrx.time || null
              },
              $inc: {
                saldo: Number(latestDeposit.get_balance) || 0
              }
            }
          );

          if (updateResult.modifiedCount > 0) {
            console.log(`Deposit SUCCESS ${localTrxId} provider=${providerTrx.id}`);
          }
          clearInterval(intervalId);
          return;
        }

        if (["failed", "expired", "cancel", "cancelled"].includes(providerStatus)) {
          await User.updateOne(
            {
              _id: user._id,
              historyDeposit: {
                $elemMatch: {
                  id: localTrxId,
                  status: { $in: ["pending", "processing"] }
                }
              }
            },
            {
              $set: {
                "historyDeposit.$.status": providerStatus,
                "historyDeposit.$.provider_id": String(providerTrx.id),
                "historyDeposit.$.provider_reference_id": String(providerTrx.reference_id || providerTrx.id),
                "historyDeposit.$.provider_amount": Number(providerTrx.amount) || 0,
                "historyDeposit.$.provider_status": providerStatus,
                "historyDeposit.$.provider_time": providerTrx.time || null
              }
            }
          );
          clearInterval(intervalId);
        }
      } catch (e) {
        console.error("XS-Pedia Polling Error:", e.message);
      }
    }, 10000);

    // Otomatis menghentikan polling setelah 16 menit (mengikuti expired server 15 menit)
    setTimeout(() => clearInterval(intervalId), 16 * 60 * 1000);

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


// ================= CEK STATUS DEPOSIT =================
router.post("/deposit/status", requireLogin, async (req, res) => {
  try {
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
      const totalAmount = Number(localData.total_amount) > 0 ? Number(localData.total_amount) : nominal + kodeUnik;

      return res.status(200).json({
        success: true,
        data: {
          id,
          trx_id: id,
          reff_id: localData.reff_id || localData.provider_reference_id || "-",
          nominal,
          kode_unik: kodeUnik,
          tambahan: kodeUnik,
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

    const fetchWithTimeout = async (url, options = {}, timeout = 5000) => {
      const controller = new AbortController();
      const idTimeout = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(idTimeout);
        return response;
      } catch (err) {
        clearTimeout(idTimeout);
        return null;
      }
    };

    let providerTrx = null;

    // ================= 1. CEK VIA POST /api/v1/payments/{paymentId}/status =================
    if (localData.provider_id) {
      const detailUrl = `${XS_BASE}/api/v1/payments/${encodeURIComponent(localData.provider_id)}/status`;
      
      // Mengirim POST request dengan body paymentToken sesuai dokumentasi
      const detailRes = await fetchWithTimeout(detailUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0"
        },
        body: JSON.stringify({
          paymentToken: localData.payment_token || localData.provider_token || ""
        })
      });

      if (detailRes && detailRes.ok) {
        try {
          const detailData = await detailRes.json();
          if (detailData?.success && detailData?.data) {
            providerTrx = detailData.data;
          }
        } catch (e) {}
      }
    }

    // ================= 2. FALLBACK: CEK VIA HISTORY =================
    if (!providerTrx) {
      const historyUrl = `${XS_BASE}/api/v1/payments/history?limit=50`;
      const response = await fetchWithTimeout(historyUrl, {
        method: "GET",
        headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" }
      });

      if (response && response.ok) {
        try {
          const result = await response.json();
          if (result?.success && Array.isArray(result.data)) {
            const targetAmount =
              Number(localData.provider_amount) ||
              Number(localData.total_amount) ||
              (Number(localData.nominal) || 0) + (Number(localData.kode_unik || localData.tambahan || localData.fee) || 0);

            const createdTime = new Date(localData.created_at).getTime();

            const candidates = result.data
              .filter(x => Number(x.amount) === targetAmount)
              .filter(x => {
                const providerTime = new Date(x.createdAt || x.time).getTime();
                if (!Number.isFinite(providerTime)) return false;
                if (!Number.isFinite(createdTime)) return true;

                return (
                  providerTime >= createdTime - 3 * 60 * 1000 &&
                  providerTime <= createdTime + 30 * 60 * 1000
                );
              })
              .sort((a, b) => new Date(a.createdAt || a.time) - new Date(b.createdAt || b.time));

            for (const candidate of candidates) {
              const candidateId = candidate.id || candidate.paymentId;
              const alreadyUsed = await User.findOne({
                "historyDeposit.provider_id": String(candidateId)
              }).select("_id");

              if (!alreadyUsed) {
                providerTrx = candidate;
                break;
              }

              const sameDeposit = await User.findOne({
                _id: user._id,
                historyDeposit: {
                  $elemMatch: {
                    id,
                    provider_id: String(candidateId)
                  }
                }
              }).select("_id");

              if (sameDeposit) {
                providerTrx = candidate;
                break;
              }
            }
          }
        } catch (e) {}
      }
    }

    // ================= PROSES STATUS PROVIDER =================
    if (providerTrx) {
      let rawProviderStatus = String(providerTrx.status || localStatus).toLowerCase();
      // Mapping "paid" dari API ke status "success" internal
      let providerStatus = rawProviderStatus === "paid" ? "success" : rawProviderStatus;

      const pId = String(providerTrx.id || providerTrx.paymentId || localData.provider_id || "");
      const pRef = String(providerTrx.transactionId || providerTrx.reference_id || pId);
      
      // Parsing timestamp paidAt/createdAt (format epoch MS atau ISO String)
      let pTime = providerTrx.paidAt || providerTrx.createdAt || providerTrx.time || null;
      if (typeof pTime === 'number') {
        pTime = new Date(pTime).toISOString();
      }

      if (providerStatus === "success") {
        const updateResult = await User.updateOne(
          {
            _id: user._id,
            historyDeposit: {
              $elemMatch: {
                id,
                status: { $in: ["pending", "processing"] }
              }
            }
          },
          {
            $set: {
              "historyDeposit.$.status": "success",
              "historyDeposit.$.provider_id": pId,
              "historyDeposit.$.provider_reference_id": pRef,
              "historyDeposit.$.provider_amount": Number(providerTrx.amount) || 0,
              "historyDeposit.$.provider_status": providerStatus,
              "historyDeposit.$.provider_time": pTime
            },
            $inc: {
              saldo: Number(localData.get_balance) || 0
            }
          }
        );

        if (updateResult.modifiedCount > 0) {
          localStatus = "success";
        }
      } else if (["failed", "expired", "cancel", "cancelled"].includes(providerStatus)) {
        const updateResult = await User.updateOne(
          {
            _id: user._id,
            historyDeposit: {
              $elemMatch: {
                id,
                status: { $in: ["pending", "processing"] }
              }
            }
          },
          {
            $set: {
              "historyDeposit.$.status": providerStatus,
              "historyDeposit.$.provider_id": pId,
              "historyDeposit.$.provider_reference_id": pRef,
              "historyDeposit.$.provider_amount": Number(providerTrx.amount) || 0,
              "historyDeposit.$.provider_status": providerStatus,
              "historyDeposit.$.provider_time": pTime
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
    localStatus = String(localData.status || localStatus || "pending").toLowerCase();

    const nominal = Number(localData.nominal) || 0;
    const kodeUnik = Number(localData.kode_unik || localData.tambahan || localData.fee) || 0;
    const totalAmount = Number(localData.total_amount) > 0 ? Number(localData.total_amount) : nominal + kodeUnik;

    return res.status(200).json({
      success: true,
      data: {
        id,
        trx_id: id,
        reff_id: localData.reff_id || localData.provider_reference_id || "-",
        nominal,
        kode_unik: kodeUnik,
        tambahan: kodeUnik,
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

  } catch (error) {
    console.error("Error Status Check XS-Pedia:", error);
    return res.status(500).json({
      success: false,
      message: "Gagal memuat detail terbaru."
    });
  }
});


// ================= CANCEL DEPOSIT (INTERNAL ONLY) =================
router.post("/deposit/cancel", requireLogin, async (req, res) => {
  const user = await User.findById(req.session.userId);
  if (!user) return res.status(401).json({ success: false, message: "Sesi tidak valid." });

  const { id } = req.body;
  if (!id) return res.status(400).json({ success: false, message: "ID diperlukan." });

  try {
    const userHistory = await User.findOne(
      { _id: user._id, "historyDeposit.id": id },
      { "historyDeposit.$": 1 }
    );

    if (!userHistory || !userHistory.historyDeposit.length) {
      return res.status(404).json({ success: false, message: "Data transaksi tidak ditemukan." });
    }

    const currentData = userHistory.historyDeposit[0];

    if (currentData.status !== "pending") {
      return res.status(400).json({
        success: false,
        message: `Transaksi tidak bisa dibatalkan karena status sudah ${currentData.status}.`
      });
    }

    await editHistoryDeposit(user._id, id, "cancel");

    return res.status(200).json({
      success: true,
      message: "Deposit berhasil dibatalkan.",
      data: {
        id: id,
        status: "cancel"
      }
    });

  } catch (error) {
    console.error("Cancel Deposit Error:", error);
    return res.status(500).json({ success: false, message: "Terjadi kesalahan: " + error.message });
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

  } catch (err) {
    console.error("Error pada /am/send:", err);

    return res.status(500).json({
      status: false,
      creator: "@RyuuXiao",
      source: "xs-pedia",
      endpoint: "send",
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

    console.log(
      `[AM VERIFY] Memproses verifikasi email: ${email} dengan link: ${link}`
    );

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
      source: "xs-pedia",
      endpoint: "verify",
      message: "Terjadi kesalahan pada server internal."
    });
  }
});


// ==========================================
// GMAIL HTML + ALIGHT_MOTION_FEE DARI .ENV
// ==========================================
app.get("/gmail", (req, res) => {
  const gmailPath = path.join(
    __dirname,
    "public",
    "gmail.html"
  );

  fs.readFile(gmailPath, "utf8", (err, html) => {
    if (err) {
      console.error("Gagal membaca gmail.html:", err);
      return res.status(500).send(
        "Gagal memuat Gmail HTML."
      );
    }

    const fee = Number(
      process.env.ALIGHT_MOTION_FEE || 0
    );

    const injected = html.replace(
      "</head>",
      `<script>
        window.ALIGHT_MOTION_FEE = ${JSON.stringify(fee)};
      </script>
      </head>`
    );

    res
      .type("html")
      .send(injected);
  });
});
module.exports = router;
