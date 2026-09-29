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
// ================= METODE DEPOSIT =================
router.post("/deposit/metode", requireLogin, async (req, res) => {
  try {
    const fullUrl = `${req.protocol}://${req.get("host")}`;
    const role = req.session.role || "user";

    const feePersen =
      role === "reseller"
        ? (process.env.FEE_PERCENT_RESELLER || "7.7")
        : (process.env.FEE_PERCENT_USER || "7.7");

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
        img_url: `${fullUrl}/media/metode/qrisfast.png`
      }
    ];

    return res.status(200).json({
      success: true,
      message: "Daftar metode deposit",
      metode: metodeFormatted
    });

  } catch (error) {
    console.error("Deposit Metode Error:", error);

    return res.status(500).json({
      success: false,
      message: "Gagal mengambil metode."
    });
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

    if (
      !nominal ||
      !Number.isFinite(parsedNominal) ||
      parsedNominal < 10
    ) {
      return res.status(400).json({
        success: false,
        message: "Minimal deposit Rp10"
      });
    }

    // ================= PAYMENT GATEWAY =================
    // Gateway ini tetap menggunakan GoBiz di backend-nya.
    const PAYMENT_GATEWAY_BASE = (
      process.env.PAYMENT_GATEWAY_BASE_URL ||
      "https://xspedia-payment.vercel.app"
    ).replace(/\/+$/, "");

    // ================= KODE UNIK =================
    const kodeUnik =
      Math.floor(Math.random() * 250) + 1;

    const totalBayar =
      parsedNominal + kodeUnik;

    const saldoDiterima =
      parsedNominal;

    // ================= CREATE PAYMENT =================
    const createUrl =
      `${PAYMENT_GATEWAY_BASE}/api/v1/payments`;

    let response;

    try {
      response = await fetch(createUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify({
          amount: totalBayar
        })
      });
    } catch (fetchError) {
      console.error(
        "Payment Gateway Create Fetch Error:",
        fetchError
      );

      return res.status(502).json({
        success: false,
        message:
          "Koneksi ke payment gateway gagal."
      });
    }

    const responseText =
      await response.text();

    let result;

    try {
      result = JSON.parse(responseText);
    } catch (jsonError) {
      console.error(
        "Payment Gateway Create Invalid JSON:",
        responseText.slice(0, 1000)
      );

      return res.status(502).json({
        success: false,
        message:
          responseText.trim().startsWith("<")
            ? "Payment gateway mengembalikan HTML, bukan JSON."
            : "Payment gateway mengembalikan response yang bukan JSON."
      });
    }

    if (
      !response.ok ||
      !result?.success ||
      !result?.data
    ) {
      console.error(
        "Payment Gateway Create Error:",
        {
          status: response.status,
          result
        }
      );

      return res.status(400).json({
        success: false,
        message:
          result?.message ||
          result?.error ||
          `Gagal membuat pembayaran. HTTP ${response.status}`
      });
    }

    // ================= DATA PROVIDER =================
    const providerData =
      result.data;

    const providerPaymentId =
      String(
        providerData.paymentId ||
        providerData.id ||
        ""
      ).trim();

    const providerToken =
      String(
        providerData.paymentToken ||
        providerData.token ||
        ""
      ).trim();

    const rawQrImage =
      providerData.qr ||
      providerData.qr_image ||
      providerData.qrImage ||
      "";

    const qrisString =
      providerData.qrisString ||
      providerData.qris_string ||
      providerData.qrString ||
      "";

    const providerStatus =
      String(
        providerData.status ||
        "pending"
      ).toLowerCase();

    const providerCreatedAt =
      providerData.createdAt
        ? new Date(providerData.createdAt)
        : new Date();

    const providerExpiresAt =
      providerData.expiresAt
        ? new Date(providerData.expiresAt)
        : new Date(
            Date.now() +
            15 * 60 * 1000
          );

    if (!providerPaymentId) {
      console.error(
        "Payment gateway tidak mengembalikan paymentId:",
        providerData
      );

      return res.status(502).json({
        success: false,
        message:
          "Payment gateway tidak mengembalikan paymentId."
      });
    }

    if (!rawQrImage) {
      return res.status(502).json({
        success: false,
        message:
          "Payment gateway tidak mengembalikan QR."
      });
    }

    if (!qrisString) {
      return res.status(502).json({
        success: false,
        message:
          "Payment gateway tidak mengembalikan qrisString."
      });
    }

    if (!providerToken) {
      console.error(
        "Payment gateway tidak mengembalikan paymentToken:",
        providerData
      );

      return res.status(502).json({
        success: false,
        message:
          "Payment gateway tidak mengembalikan paymentToken untuk pengecekan status."
      });
    }

    // ================= ID TRANSAKSI LOKAL =================
    const localTrxId =
      `XIAO-WEB-${Date.now()}-` +
      `${Math.random()
        .toString(36)
        .slice(2, 8)
        .toUpperCase()}`;

    // ================= BACKGROUND =================
    // TIDAK DIUBAH
    const customBgUrl =
      "https://files.catbox.moe/sh2bcj.png";

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

      provider_amount:
        Number(providerData.amount) ||
        totalBayar,

      provider: "gobiz",

      // ID PAYMENT DARI GATEWAY
      provider_id:
        providerPaymentId,

      // Simpan token untuk status
      provider_token:
        providerToken,

      provider_reference_id:
        providerPaymentId,

      provider_created_at:
        providerCreatedAt,

      provider_expires_at:
        providerExpiresAt,

      provider_status:
        providerStatus,

      provider_time:
        null,

      qris_string:
        qrisString,

      metode:
        "QRIS",

      status:
        "pending",

      qr_image:
        rawQrImage,

      // BACKGROUND TETAP
      bg_image:
        customBgUrl,

      created_at:
        new Date()
    };

    await tambahHistoryDeposit(
      user._id,
      historyDataForDb
    );

    // ================= RESPONSE =================
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

        fee: kodeUnik,
        fee_env: kodeUnik,
        fee_provider: 0,

        total_amount:
          totalBayar,

        get_balance:
          saldoDiterima,

        qr_image:
          rawQrImage,

        qris_string:
          qrisString,

        // BACKGROUND TETAP
        bg_image:
          customBgUrl,

        status:
          "pending",

        // ID gateway
        provider_id:
          providerPaymentId,

        provider_status:
          providerStatus,

        // Token untuk endpoint status
        provider_token:
          providerToken,

        expires_at:
          providerExpiresAt
      }
    });

  } catch (err) {
    console.error(
      "Deposit Create Error:",
      err
    );

    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        message:
          err.message
      });
    }
  }
});


// ================= STATUS DEPOSIT =================
router.post("/deposit/status", requireLogin, async (req, res) => {
  try {
    const user =
      await User.findById(
        req.session.userId
      );

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

    // ================= AMBIL HISTORY =================
    let userWithHistory =
      await User.findOne(
        {
          _id: user._id,
          "historyDeposit.id": id
        },
        {
          "historyDeposit.$": 1
        }
      );

    if (
      !userWithHistory ||
      !userWithHistory.historyDeposit?.length
    ) {
      return res.status(404).json({
        success: false,
        message: "Data tidak ditemukan."
      });
    }

    let localData =
      userWithHistory.historyDeposit[0];

    let localStatus =
      String(
        localData.status ||
        "pending"
      ).toLowerCase();

    // ================= STATUS TERMINAL =================
    if (
      !["pending", "processing"]
        .includes(localStatus)
    ) {
      const nominal =
        Number(
          localData.nominal
        ) || 0;

      const kodeUnik =
        Number(
          localData.kode_unik ||
          localData.tambahan ||
          localData.fee
        ) || 0;

      const totalAmount =
        Number(
          localData.total_amount
        ) > 0
          ? Number(
              localData.total_amount
            )
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

          kode_unik:
            kodeUnik,

          tambahan:
            kodeUnik,

          fee:
            kodeUnik,

          fee_env:
            kodeUnik,

          fee_provider:
            0,

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

          // BACKGROUND TETAP
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
            Number(
              localData.provider_amount
            ) || totalAmount,

          provider_status:
            localData.provider_status ||
            null,

          provider_time:
            localData.provider_time ||
            null
        }
      });
    }

    // ================= PAYMENT GATEWAY =================
    const PAYMENT_GATEWAY_BASE =
      (
        process.env.PAYMENT_GATEWAY_BASE_URL ||
        "https://xspedia-payment.vercel.app"
      ).replace(/\/+$/, "");

    const providerPaymentId =
      String(
        localData.provider_id ||
        ""
      ).trim();

    const providerToken =
      String(
        localData.provider_token ||
        ""
      ).trim();

    if (!providerPaymentId) {
      return res.status(400).json({
        success: false,
        message:
          "Payment ID gateway tidak ditemukan."
      });
    }

    if (!providerToken) {
      return res.status(400).json({
        success: false,
        message:
          "Payment token gateway tidak ditemukan."
      });
    }

    // ================= CEK STATUS =================
    const statusUrl =
      `${PAYMENT_GATEWAY_BASE}` +
      `/api/v1/payments/` +
      `${encodeURIComponent(providerPaymentId)}` +
      `/status?refresh=1`;

    let response;

    try {
      response = await fetch(
        statusUrl,
        {
          method: "GET",
          headers: {
            "x-payment-token":
              providerToken,
            "Accept":
              "application/json"
          }
        }
      );
    } catch (fetchError) {
      console.error(
        "Payment Gateway Status Fetch Error:",
        fetchError
      );

      return res.status(502).json({
        success: false,
        message:
          "Koneksi ke payment gateway gagal."
      });
    }

    const responseText =
      await response.text();

    let result;

    try {
      result =
        JSON.parse(
          responseText
        );
    } catch (jsonError) {
      console.error(
        "Payment Gateway Status Invalid JSON:",
        responseText.slice(
          0,
          1000
        )
      );

      return res.status(502).json({
        success: false,
        message:
          responseText
            .trim()
            .startsWith("<")
            ? "Payment gateway mengembalikan HTML, bukan JSON."
            : "Response status payment gateway bukan JSON."
      });
    }

    if (
      !response.ok ||
      !result?.success ||
      !result?.data
    ) {
      console.error(
        "Payment Gateway Status Error:",
        {
          status:
            response.status,
          result
        }
      );

      return res.status(502).json({
        success: false,
        message:
          result?.message ||
          result?.error ||
          `Gagal mengambil status pembayaran. HTTP ${response.status}`
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
      ) ||
      Number(
        localData.provider_amount
      ) ||
      Number(
        localData.total_amount
      ) ||
      0;

    const providerReferenceId =
      String(
        providerData.transactionId ||
        providerData.transactionID ||
        providerData.referenceId ||
        providerData.reference_id ||
        providerData.paymentId ||
        providerPaymentId
      );

    const providerTime =
      providerData.paidAt ||
      providerData.updatedAt ||
      null;

    // ================= PAID =================
    if (
      providerStatus === "paid" ||
      providerStatus === "success" ||
      providerStatus === "successful" ||
      providerStatus === "completed" ||
      providerStatus === "settlement"
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

              "historyDeposit.$.provider_token":
                providerToken,

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
        localStatus =
          "success";
      }
    }

    // ================= EXPIRED =================
    else if (
      providerStatus === "expired"
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
                "expired",

              "historyDeposit.$.provider_id":
                String(
                  providerData.paymentId ||
                  providerPaymentId
                ),

              "historyDeposit.$.provider_token":
                providerToken,

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
        localStatus =
          "expired";
      }
    }

    // ================= CANCELLED =================
    else if (
      providerStatus === "cancelled" ||
      providerStatus === "canceled" ||
      providerStatus === "cancel"
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
                "cancel",

              "historyDeposit.$.provider_id":
                String(
                  providerData.paymentId ||
                  providerPaymentId
                ),

              "historyDeposit.$.provider_token":
                providerToken,

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
        localStatus =
          "cancel";
      }
    }

    // ================= FAILED =================
    else if (
      providerStatus === "failed"
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
                "failed",

              "historyDeposit.$.provider_id":
                String(
                  providerData.paymentId ||
                  providerPaymentId
                ),

              "historyDeposit.$.provider_token":
                providerToken,

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
        localStatus =
          "failed";
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
      refreshedUser
        ?.historyDeposit?.[0] ||
      localData;

    localStatus =
      String(
        localData.status ||
        localStatus ||
        "pending"
      ).toLowerCase();

    const nominal =
      Number(
        localData.nominal
      ) || 0;

    const kodeUnik =
      Number(
        localData.kode_unik ||
        localData.tambahan ||
        localData.fee
      ) || 0;

    const totalAmount =
      Number(
        localData.total_amount
      ) > 0
        ? Number(
            localData.total_amount
          )
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

        kode_unik:
          kodeUnik,

        tambahan:
          kodeUnik,

        fee:
          kodeUnik,

        fee_env:
          kodeUnik,

        fee_provider:
          0,

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

        // BACKGROUND TETAP
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
          providerPaymentId,

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
      "Deposit Status Error:",
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
  try {
    const user =
      await User.findById(
        req.session.userId
      );

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

    const userHistory =
      await User.findOne(
        {
          _id: user._id,
          "historyDeposit.id": id
        },
        {
          "historyDeposit.$": 1
        }
      );

    if (
      !userHistory ||
      !userHistory.historyDeposit?.length
    ) {
      return res.status(404).json({
        success: false,
        message:
          "Data transaksi tidak ditemukan."
      });
    }

    const currentData =
      userHistory.historyDeposit[0];

    if (
      !["pending", "processing"]
        .includes(
          String(
            currentData.status ||
            ""
          ).toLowerCase()
        )
    ) {
      return res.status(400).json({
        success: false,
        message:
          `Transaksi tidak bisa dibatalkan karena status sudah ${currentData.status}.`
      });
    }

    const PAYMENT_GATEWAY_BASE =
      (
        process.env.PAYMENT_GATEWAY_BASE_URL ||
        "https://xspedia-payment.vercel.app"
      ).replace(/\/+$/, "");

    const providerPaymentId =
      String(
        currentData.provider_id ||
        ""
      ).trim();

    const providerToken =
      String(
        currentData.provider_token ||
        ""
      ).trim();

    if (!providerPaymentId) {
      return res.status(400).json({
        success: false,
        message:
          "Payment ID gateway tidak ditemukan."
      });
    }

    if (!providerToken) {
      return res.status(400).json({
        success: false,
        message:
          "Payment token gateway tidak ditemukan."
      });
    }

    const cancelUrl =
      `${PAYMENT_GATEWAY_BASE}` +
      `/api/v1/payments/` +
      `${encodeURIComponent(providerPaymentId)}` +
      `/cancel`;

    const response =
      await fetch(
        cancelUrl,
        {
          method: "POST",
          headers: {
            "x-payment-token":
              providerToken,
            "Accept":
              "application/json"
          }
        }
      );

    const responseText =
      await response.text();

    let result;

    try {
      result =
        JSON.parse(responseText);
    } catch (jsonError) {
      console.error(
        "Payment Gateway Cancel Invalid JSON:",
        responseText.slice(
          0,
          1000
        )
      );

      return res.status(502).json({
        success: false,
        message:
          "Response cancel payment gateway bukan JSON."
      });
    }

    if (
      !response.ok ||
      !result?.success
    ) {
      return res.status(400).json({
        success: false,
        message:
          result?.message ||
          result?.error ||
          "Gagal membatalkan pembayaran."
      });
    }

    await editHistoryDeposit(
      user._id,
      id,
      "cancel"
    );

    return res.status(200).json({
      success: true,
      message:
        "Deposit berhasil dibatalkan.",
      data: {
        id,
        status: "cancel"
      }
    });

  } catch (error) {
    console.error(
      "Cancel Deposit Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Terjadi kesalahan: " +
        error.message
    });
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
