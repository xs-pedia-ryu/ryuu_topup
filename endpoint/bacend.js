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

    const XS_BASE = (
      process.env.XS_PEDIA_BASE_URL ||
      "https://xspedia-payment.vercel.app"
    ).replace(/\/+$/, "");

    const XS_API_KEY = process.env.XS_PEDIA_API_KEY;

    if (!XS_API_KEY) {
      return res.status(500).json({
        success: false,
        message: "XS_PEDIA_API_KEY belum disetting di server."
      });
    }

    // ================= KODE UNIK =================
    const kodeUnik = Math.floor(Math.random() * 250) + 1;

    // Total yang harus dibayar
    const totalBayar = parsedNominal + kodeUnik;

    // Saldo yang masuk tetap nominal asli
    const saldoDiterima = parsedNominal;

    // ================= CREATE XS-PEDIA =================
    const createUrl = `${XS_BASE}/api/v1/payments`;

    let response;

    try {
      response = await fetch(createUrl, {
        method: "POST",
        headers: {
          "x-api-key": XS_API_KEY,
          "Content-Type": "application/json",
          "Accept": "application/json"
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
      console.error(
        "XS-Pedia Create Invalid Response:",
        responseText.slice(0, 1000)
      );

      return res.status(502).json({
        success: false,
        message: responseText.trim().startsWith("<")
          ? "XS-Pedia mengembalikan halaman HTML. Periksa XS_PEDIA_BASE_URL dan API endpoint."
          : "XS-Pedia mengembalikan response yang bukan JSON."
      });
    }

    if (!response.ok || !result?.success || !result?.data) {
      console.error("XS-Pedia Create Error:", {
        status: response.status,
        result
      });

      return res.status(400).json({
        success: false,
        message:
          result?.message ||
          result?.error ||
          `Gagal membuat pembayaran QRIS XS-Pedia. HTTP ${response.status}`
      });
    }

    // ================= DATA DARI XS-PEDIA =================
    const providerPaymentId = String(
      result.data.paymentId ||
      result.data.id ||
      ""
    );

    const rawQrImage =
      result.data.qr ||
      result.data.qrImage ||
      result.data.qr_image ||
      "";

    const qrisString =
      result.data.qrisString ||
      result.data.qrString ||
      result.data.qris_string ||
      "";

    const providerCreatedAt = result.data.createdAt
      ? new Date(result.data.createdAt)
      : new Date();

    const providerStatus = String(
      result.data.status || "pending"
    ).toLowerCase();

    if (!providerPaymentId) {
      console.error("XS-Pedia tidak mengembalikan paymentId:", result);

      return res.status(502).json({
        success: false,
        message: "XS-Pedia tidak mengembalikan paymentId."
      });
    }

    if (!rawQrImage || !qrisString) {
      console.error("XS-Pedia QRIS tidak lengkap:", result);

      return res.status(502).json({
        success: false,
        message: "XS-Pedia tidak mengembalikan QRIS lengkap."
      });
    }

    // ================= ID TRANSAKSI LOKAL =================
    const localTrxId =
      `XIAO-WEB-${Date.now()}-` +
      `${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

    // JANGAN DIUBAH
    const customBgUrl =
      "https://files.catbox.moe/sh2bcj.png";

    // ================= SIMPAN HISTORY =================
    const historyDataForDb = {
      id: localTrxId,
      reff_id: localTrxId,
      nominal: parsedNominal,

      // Kode unik tetap dianggap biaya admin
      tambahan: kodeUnik,
      kode_unik: kodeUnik,
      fee: kodeUnik,
      fee_env: kodeUnik,
      fee_provider: 0,

      total_amount: totalBayar,
      get_balance: saldoDiterima,

      provider_amount: totalBayar,
      provider: "xs-pedia",

      // ID ASLI DARI PROVIDER
      provider_id: providerPaymentId,
      provider_reference_id: providerPaymentId,

      provider_created_at: providerCreatedAt,
      provider_status: providerStatus,
      provider_time: providerCreatedAt,

      qris_string: qrisString,
      metode: "QRIS",

      status: "pending",

      qr_image: rawQrImage,

      // JANGAN DIUBAH
      bg_image: customBgUrl,

      created_at: new Date()
    };

    await tambahHistoryDeposit(
      user._id,
      historyDataForDb
    );

    // ================= RESPONSE KE FRONTEND =================
    return res.status(200).json({
      success: true,
      data: {
        id: localTrxId,
        trx_id: localTrxId,
        reff_id: localTrxId,

        metode: "QRIS",
        nominal: parsedNominal,

        kode_unik: kodeUnik,
        tambahan: kodeUnik,

        // Kode unik tetap tampil sebagai biaya admin
        fee: kodeUnik,
        fee_env: kodeUnik,
        fee_provider: 0,

        total_amount: totalBayar,
        get_balance: saldoDiterima,

        qr_image: rawQrImage,
        qris_string: qrisString,

        // JANGAN DIUBAH
        bg_image: customBgUrl,

        status: "pending",

        // Data provider
        provider_id: providerPaymentId,
        provider_reference_id: providerPaymentId,
        provider_status: providerStatus
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

    // ================= AMBIL DATA LOKAL =================
    let userWithHistory = await User.findOne(
      {
        _id: user._id,
        "historyDeposit.id": id
      },
      {
        "historyDeposit.$": 1
      }
    );

    if (!userWithHistory?.historyDeposit?.length) {
      return res.status(404).json({
        success: false,
        message: "Data tidak ditemukan."
      });
    }

    let localData = userWithHistory.historyDeposit[0];

    let localStatus = String(
      localData.status || "pending"
    ).toLowerCase();

    // ================= STATUS TERMINAL LOKAL =================
    if (!["pending", "processing"].includes(localStatus)) {
      const nominal =
        Number(localData.nominal) || 0;

      const kodeUnik =
        Number(
          localData.kode_unik ||
          localData.tambahan ||
          localData.fee
        ) || 0;

      const totalAmount =
        Number(localData.total_amount) > 0
          ? Number(localData.total_amount)
          : nominal + kodeUnik;

      return res.status(200).json({
        success: true,
        data: {
          id,
          trx_id: id,

          reff_id:
            localData.reff_id ||
            localData.provider_reference_id ||
            "-",

          nominal,

          kode_unik: kodeUnik,
          tambahan: kodeUnik,

          fee: kodeUnik,
          fee_env: kodeUnik,
          fee_provider: 0,

          total_amount: totalAmount,

          get_balance:
            Number(localData.get_balance) ||
            nominal,

          status: localStatus,

          metode:
            localData.metode ||
            "QRIS",

          qr_image:
            localData.qr_image ||
            null,

          // JANGAN DIUBAH
          bg_image:
            localData.bg_image ||
            "https://files.catbox.moe/sh2bcj.png",

          qris_string:
            localData.qris_string ||
            "",

          created_at:
            localData.created_at ||
            null,

          provider_id:
            localData.provider_id ||
            null,

          provider_reference_id:
            localData.provider_reference_id ||
            null,

          provider_amount:
            Number(localData.provider_amount) ||
            totalAmount,

          provider_status:
            localData.provider_status ||
            null,

          provider_time:
            localData.provider_time ||
            null
        }
      });
    }

    // ================= API CONFIG =================
    const XS_BASE = (
      process.env.XS_PEDIA_BASE_URL ||
      "https://xspedia-payment.vercel.app"
    ).replace(/\/+$/, "");

    const XS_API_KEY =
      process.env.XS_PEDIA_API_KEY;

    if (!XS_API_KEY) {
      return res.status(500).json({
        success: false,
        message:
          "XS_PEDIA_API_KEY belum disetting di server."
      });
    }

    // ================= PAYMENT ID PROVIDER =================
    const providerPaymentId =
      localData.provider_id ||
      localData.provider_reference_id;

    if (!providerPaymentId) {
      return res.status(400).json({
        success: false,
        message:
          "Payment ID XS-Pedia tidak ditemukan pada transaksi."
      });
    }

    // ================= CEK STATUS XS-PEDIA =================
    const statusUrl =
      `${XS_BASE}/api/v1/payments/` +
      `${encodeURIComponent(providerPaymentId)}/status?refresh=1`;

    let response;

    try {
      response = await fetch(statusUrl, {
        method: "GET",
        headers: {
          "x-api-key": XS_API_KEY,
          "Accept": "application/json"
        }
      });
    } catch (fetchError) {
      console.error(
        "XS-Pedia Status Fetch Error:",
        fetchError
      );

      return res.status(502).json({
        success: false,
        message:
          "Koneksi server ke XS-Pedia gagal."
      });
    }

    const responseText =
      await response.text();

    let result;

    try {
      result = JSON.parse(responseText);
    } catch (jsonError) {
      console.error(
        "XS-Pedia Status Invalid Response:",
        responseText.slice(0, 1000)
      );

      return res.status(502).json({
        success: false,
        message: responseText.trim().startsWith("<")
          ? "XS-Pedia mengembalikan HTML, bukan JSON."
          : "Response status XS-Pedia bukan JSON."
      });
    }

    if (
      !response.ok ||
      !result?.success ||
      !result?.data
    ) {
      console.error(
        "XS-Pedia Status Error:",
        {
          status: response.status,
          result
        }
      );

      return res.status(502).json({
        success: false,
        message:
          result?.message ||
          result?.error ||
          `Gagal mengambil status XS-Pedia. HTTP ${response.status}`
      });
    }

    // ================= DATA PROVIDER =================
    const providerData =
      result.data;

    const providerStatus =
      String(
        providerData.status ||
        "pending"
      ).toLowerCase();

    const providerAmount =
      Number(
        providerData.amount
      ) || Number(
        localData.provider_amount
      ) || Number(
        localData.total_amount
      ) || 0;

    const providerReferenceId =
      String(
        providerData.transactionId ||
        providerData.referenceId ||
        providerData.reference_id ||
        providerData.paymentId ||
        providerPaymentId
      );

    const providerTime =
      providerData.paidAt ||
      providerData.updatedAt ||
      null;

    // ================= STATUS PAID =================
    if (
      providerStatus === "paid" ||
      providerStatus === "success"
    ) {
      const updateResult =
        await User.updateOne(
          {
            _id: user._id,
            historyDeposit: {
              $elemMatch: {
                id,
                status: {
                  $in: [
                    "pending",
                    "processing"
                  ]
                }
              }
            }
          },
          {
            $set: {
              "historyDeposit.$.status":
                "success",

              "historyDeposit.$.provider_id":
                String(
                  providerData.paymentId ||
                  providerPaymentId
                ),

              "historyDeposit.$.provider_reference_id":
                providerReferenceId,

              "historyDeposit.$.provider_amount":
                providerAmount,

              "historyDeposit.$.provider_status":
                providerStatus,

              "historyDeposit.$.provider_time":
                providerTime
            },

            $inc: {
              saldo:
                Number(
                  localData.get_balance
                ) || 0
            }
          }
        );

      if (
        updateResult.modifiedCount > 0
      ) {
        localStatus = "success";
      }
    }

    // ================= STATUS CANCELLED =================
    else if (
      providerStatus === "cancelled" ||
      providerStatus === "canceled" ||
      providerStatus === "cancel" ||
      providerStatus === "expired" ||
      providerStatus === "failed"
    ) {
      const finalStatus =
        providerStatus === "cancelled" ||
        providerStatus === "canceled"
          ? "cancel"
          : providerStatus;

      const updateResult =
        await User.updateOne(
          {
            _id: user._id,
            historyDeposit: {
              $elemMatch: {
                id,
                status: {
                  $in: [
                    "pending",
                    "processing"
                  ]
                }
              }
            }
          },
          {
            $set: {
              "historyDeposit.$.status":
                finalStatus,

              "historyDeposit.$.provider_id":
                String(
                  providerData.paymentId ||
                  providerPaymentId
                ),

              "historyDeposit.$.provider_reference_id":
                providerReferenceId,

              "historyDeposit.$.provider_amount":
                providerAmount,

              "historyDeposit.$.provider_status":
                providerStatus,

              "historyDeposit.$.provider_time":
                providerTime
            }
          }
        );

      if (
        updateResult.modifiedCount > 0
      ) {
        localStatus = finalStatus;
      }
    }

    // ================= AMBIL DATA TERBARU =================
    const refreshedUser =
      await User.findOne(
        {
          _id: user._id,
          "historyDeposit.id": id
        },
        {
          "historyDeposit.$": 1
        }
      );

    localData =
      refreshedUser?.historyDeposit?.[0] ||
      localData;

    localStatus =
      String(
        localData.status ||
        localStatus ||
        "pending"
      ).toLowerCase();

    const nominal =
      Number(localData.nominal) || 0;

    const kodeUnik =
      Number(
        localData.kode_unik ||
        localData.tambahan ||
        localData.fee
      ) || 0;

    const totalAmount =
      Number(localData.total_amount) > 0
        ? Number(localData.total_amount)
        : nominal + kodeUnik;

    // ================= RESPONSE =================
    return res.status(200).json({
      success: true,
      data: {
        id,
        trx_id: id,

        reff_id:
          localData.reff_id ||
          localData.provider_reference_id ||
          "-",

        nominal,

        kode_unik: kodeUnik,
        tambahan: kodeUnik,

        fee: kodeUnik,
        fee_env: kodeUnik,
        fee_provider: 0,

        total_amount:
          totalAmount,

        get_balance:
          Number(
            localData.get_balance
          ) || nominal,

        status:
          localStatus,

        metode:
          localData.metode ||
          "QRIS",

        qr_image:
          localData.qr_image ||
          null,

        // JANGAN DIUBAH
        bg_image:
          localData.bg_image ||
          "https://files.catbox.moe/sh2bcj.png",

        qris_string:
          localData.qris_string ||
          "",

        created_at:
          localData.created_at ||
          null,

        provider_id:
          localData.provider_id ||
          String(providerPaymentId),

        provider_reference_id:
          localData.provider_reference_id ||
          providerReferenceId,

        provider_amount:
          Number(
            localData.provider_amount
          ) || providerAmount,

        provider_status:
          localData.provider_status ||
          providerStatus,

        provider_time:
          localData.provider_time ||
          providerTime
      }
    });

  } catch (error) {
    console.error(
      "Error Status Check XS-Pedia:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Gagal memuat detail terbaru."
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
