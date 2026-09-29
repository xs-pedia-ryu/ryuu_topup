const express = require("express");
const qs = require("qs");
const cloudscraper = require("cloudscraper");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const QRCode = require("qrcode");
const router = express.Router();

// KONFIGURASI PROV
const PAYINAJA_API_KEY = process.env.PAYINAJA_API_KEY;
const PAYINAJA_BASE_URL = "https://payinaja.com/api/v1";

const {
  validateApiKey,
  User,
  tambahHistoryDeposit,
  generateReffId,
  BASE_URL, // Tetap dipakai untuk orderan (Atlantic)
  ATLAN_API_KEY, // Tetap dipakai untuk orderan (Atlantic)
  editHistoryDeposit,
  tambahHistoryOrder,
  editHistoryOrder,
} = require("../index.js");

const cloudscraperHeaders = {
  "Content-Type": "application/x-www-form-urlencoded",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
};


// ==========================================
// HELPER QRIS COMPOSITE (BACKGROUND + QR)
// ==========================================
const QR_OUTPUT_DIR = path.join(__dirname, "../media/generated-qris");
const DEFAULT_BG_URL = "https://files.catbox.moe/43lq1g.png";
const DEFAULT_BG_PATH = path.join(__dirname, "../media/bg.jpg");

function getFeePercentForRole(role) {
  const raw = role === "reseller"
    ? process.env.FEE_PERCENT_RESELLER
    : process.env.FEE_PERCENT_USER;

  const parsed = Number.parseFloat(raw);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;

  return role === "reseller" ? 2.5 : 5.5;
}

async function fetchBuffer(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    },
  });

  if (!response.ok) {
    throw new Error(`Gagal mengambil gambar (${response.status})`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function createQrisComposite({
  trxId,
  qrisImageUrl,
  qrisString,
  backgroundPath = DEFAULT_BG_PATH,
  backgroundUrl = DEFAULT_BG_URL,
}) {
  await fs.promises.mkdir(QR_OUTPUT_DIR, { recursive: true });

  let backgroundBuffer;
  try {
    backgroundBuffer = await fs.promises.readFile(backgroundPath);
  } catch {
    backgroundBuffer = await fetchBuffer(backgroundUrl);
  }

  // PENTING: gunakan QR IMAGE ASLI dari Payinaja terlebih dahulu.
  // Jangan generate ulang dari qris_string jika image provider tersedia,
  // karena image asli adalah QR yang sudah diterbitkan provider.
  let qrBuffer;

  if (qrisImageUrl) {
    qrBuffer = await fetchBuffer(qrisImageUrl);
  } else if (qrisString) {
    qrBuffer = await QRCode.toBuffer(qrisString, {
      type: "png",
      width: 1200,
      margin: 4,
      errorCorrectionLevel: "H",
      color: {
        dark: "#000000",
        light: "#FFFFFF",
      },
    });
  } else {
    throw new Error("QRIS image/string dari provider tidak tersedia.");
  }

  // Background tetap proporsional dan menjadi RGB/PNG penuh.
  const baseBuffer = await sharp(backgroundBuffer)
    .rotate()
    .resize({
      width: 1200,
      fit: "inside",
      withoutEnlargement: false,
    })
    .flatten({ background: "#FFFFFF" })
    .png()
    .toBuffer();

  const meta = await sharp(baseBuffer).metadata();

  const width = meta.width || 1200;
  const height = meta.height || 1200;

  // QR dibuat cukup besar agar mudah dideteksi kamera.
  const qrSize = Math.min(
    700,
    Math.floor(width * 0.95),
    Math.floor(height * 0.20)
  );

  // jPanel putih + quiet-zone besar.
  // QR tetap berada di atas background, tetapi area QR bersih.
  const qrPrepared = await sharp(qrBuffer)
    .rotate()
    .flatten({ background: "#FFFFFF" })
    .resize({
      width: qrSize,
      height: qrSize,
      fit: "contain",
      background: "#FFFFFF",
    })
    .extend({
      top: 55,
      bottom: 55,
      left: 55,
      right: 55,
      background: "#FFFFFF",
    })
    .png()
    .toBuffer();

  const qrMeta = await sharp(qrPrepared).metadata();

  const qrWidth = qrMeta.width || qrSize + 110;
  const qrHeight = qrMeta.height || qrSize + 110;

  // Posisi di tengah bagian bawah, seluruh QR harus tetap terlihat.
  const left = Math.max(
    0,
    Math.floor((width - qrWidth) / 2)
  );

  const top = Math.max(
    0,
    Math.min(
      height - qrHeight - 20,
      Math.floor(height * 0.41)
    )
  );

  const filename =
    `${String(trxId).replace(/[^a-zA-Z0-9_-]/g, "_")}.png`;

  const outputPath =
    path.join(QR_OUTPUT_DIR, filename);

  await sharp(baseBuffer)
    .composite([
      {
        input: qrPrepared,
        left,
        top,
        blend: "over",
      },
    ])
    .flatten({ background: "#FFFFFF" })
    .png({
      compressionLevel: 6,
      adaptiveFiltering: true,
      force: true,
    })
    .toFile(outputPath);

  return {
    filename,
    path: outputPath,
  };
}

router.get("/profile", validateApiKey, async (req, res) => {
  try {
    const user = req.user;

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found after API key validation",
      });
    }

    return res.status(200).json({
      success: true,
      user: {
        fullname: user.fullname,
        username: user.username,
        nomor: user.nomor,
        email: user.email,
        profileUrl: user.profileUrl,
        saldo: user.saldo,
        coin: user.coin,
        tanggalDaftar: user.tanggalDaftar,
        role: user.role,
        isVerified: user.isVerified,
        lastLogin: user.lastLogin,
        referralCode: user.referralCode,
      },
    });
  } catch (error) {
    console.error("Error fetching user profile via API:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

router.get("/mutasi", validateApiKey, async (req, res) => {
  try {
    const user = req.user;

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found after API key validation",
      });
    }

    const historyDeposit = user.historyDeposit || [];
    const historyOrder = user.historyOrder || [];

    historyDeposit.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    historyOrder.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    return res.status(200).json({
      success: true,
      mutasiDeposit: historyDeposit,
      mutasiOrder: historyOrder,
    });
  } catch (error) {
    console.error("Error fetching mutation history via API:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});
// === ROUTE DAFTAR METODE (STRUKTUR ASLI - PAYINAJA) ===
router.get("/deposit/metode", validateApiKey, async (req, res) => {
  try {
    const fullUrl = `${req.protocol}://${req.get("host")}`;
    const role = req.user?.role || "user";
    
    // Fee mengikuti .env agar sama dengan deposit web.
    const feePersen = String(getFeePercentForRole(role));

    const metodeFormatted = [{
      metode: "QRIS",
      type: "ewallet",
      name: "QRIS All Payment (Otomatis)",
      min: 10,
      max: 5000000,
      fee: 0,
      fee_persen: feePersen,
      status: "aktif",
      img_url: `${fullUrl}/media/metode/qrisfast.png`, // Gunakan path lokal kamu
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
// ================= XS-PEDIA HELPER =================
const XS_PEDIA_BASE_URL = process.env.XS_PEDIA_BASE_URL || "https://xs-pedia-payment.vercel.app";
const XS_PEDIA_TOKEN = process.env.XS_PEDIA_TOKEN;
const XS_PEDIA_STATIC_QR = process.env.XS_PEDIA_STATIC_QR;

async function getXsHistory() {
  if (!XS_PEDIA_TOKEN) throw new Error("XS_PEDIA_TOKEN belum disetting.");
  const r = await fetch(`${XS_PEDIA_BASE_URL}/api/history?token=${encodeURIComponent(XS_PEDIA_TOKEN)}`, {
    headers: { Accept: "application/json" }
  });
  const d = await r.json();
  if (!r.ok || !d?.success) throw new Error(d?.message || "Gagal mengambil history XS-Pedia.");
  return Array.isArray(d.data) ? d.data : [];
}

function findXsTransaction(list, amount, createdAt) {
  const a = Number(amount);
  const t = new Date(createdAt).getTime();
  return list
    .filter(x => Number(x.amount) === a)
    .filter(x => {
      const xt = new Date(x.time).getTime();
      return Number.isFinite(xt) && xt >= t - 2 * 60 * 1000;
    })
    .sort((x, y) => new Date(x.time) - new Date(y.time))[0] || null;
}

async function settleDeposit(userId, trxId, status, balance = 0) {
  if (status === "success") {
    const r = await User.updateOne(
      {
        _id: userId,
        historyDeposit: {
          $elemMatch: {
            id: trxId,
            status: { $in: ["pending", "processing"] }
          }
        }
      },
      {
        $set: { "historyDeposit.$.status": "success" },
        $inc: { saldo: Number(balance) || 0 }
      }
    );
    return r.modifiedCount > 0;
  }

  const r = await User.updateOne(
    {
      _id: userId,
      historyDeposit: {
        $elemMatch: {
          id: trxId,
          status: { $in: ["pending", "processing"] }
        }
      }
    },
    { $set: { "historyDeposit.$.status": status } }
  );

  return r.modifiedCount > 0;
}

// ================= CREATE DEPOSIT XS-PEDIA =================
router.get("/deposit/create", validateApiKey, async (req, res) => {
  const { user } = req;
  const { nominal } = req.query;

  if (!nominal || isNaN(nominal)) return res.status(400).json({ success: false, message: "Nominal tidak valid." });

  const parsedNominal = parseInt(nominal, 10);

  if (!Number.isInteger(parsedNominal) || parsedNominal < 10)
    return res.status(400).json({ success: false, message: "Minimal deposit Rp10" });

  if (!user?._id) return res.status(401).json({ success: false, message: "User API tidak valid." });

  try {
    // ================= KODE UNIK =================
    const kodeUnik = Math.floor(Math.random() * 250) + 1;
    const providerAmount = parsedNominal + kodeUnik;

    // ================= REQUEST KE XS-PEDIA API v1 =================
    const createUrl = `${XS_PEDIA_BASE_URL}/api/v1/payments`;
    let createRes;

    try {
      createRes = await fetch(createUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0"
        },
        body: JSON.stringify({ amount: providerAmount })
      });
    } catch (e) {
      console.error("XS-Pedia Create Fetch Error:", e);
      return res.status(502).json({
        success: false,
        message: "Koneksi ke XS-Pedia gagal."
      });
    }

    const createText = await createRes.text();
    let result;

    try {
      result = JSON.parse(createText);
    } catch (e) {
      console.error("XS-Pedia Create Invalid JSON:", createText.slice(0, 500));
      return res.status(502).json({
        success: false,
        message: "Response XS-Pedia bukan JSON."
      });
    }

    if (!createRes.ok || !result?.success || !result?.data) {
      return res.status(502).json({
        success: false,
        message: result?.message || result?.error || "Gagal membuat QRIS."
      });
    }

    const paymentData = result.data;
    
    // PERBAIKAN 1: Cari ID transaksi dari berbagai kemungkinan properti response XS-Pedia
    const providerPaymentId = paymentData.id || paymentData.paymentId || paymentData.trx_id || paymentData.reference_id;
    const rawQrImage = paymentData.qr || paymentData.qr_image || paymentData.qr_url || "";
    const qrisString = paymentData.qrisString || paymentData.qris_string || paymentData.qris || "";

    if (!rawQrImage || !providerPaymentId) {
      return res.status(502).json({
        success: false,
        message: "Response QRIS XS-Pedia tidak lengkap (QR atau ID Kosong)."
      });
    }

    const trxId = String(providerPaymentId);
    const nominalAsli = parsedNominal;

    // PERBAIKAN 2: Safe Parsing Date
    let pCreatedAt = new Date().toISOString();
    if (paymentData.createdAt) {
      pCreatedAt = new Date(paymentData.createdAt).toISOString();
    }

    let pExpiresAt = null;
    if (paymentData.expiresAt) {
      pExpiresAt = new Date(paymentData.expiresAt).toISOString();
    } else {
      pExpiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    }

    const bgUrl = typeof DEFAULT_BG_URL !== 'undefined' ? DEFAULT_BG_URL : '';

    // ================= BACKGROUND / COMPOSITE =================
    let compositeQrUrl = rawQrImage;
    if (typeof createQrisComposite === 'function') {
      try {
        const generated = await createQrisComposite({
          trxId,
          qrisImageUrl: rawQrImage,
          qrisString
        });
        compositeQrUrl = `${req.protocol}://${req.get("host")}/media/generated-qris/${generated.filename}`;
      } catch (e) {
        console.error("QR Composite Error:", e.message);
      }
    }

    // ================= HISTORY =================
    const history = {
      id: trxId,
      reference_id: trxId,
      nominal: nominalAsli,
      tambahan: kodeUnik,
      kode_unik: kodeUnik,
      fee: kodeUnik,
      fee_env: kodeUnik,
      fee_provider: 0,
      total_amount: providerAmount,
      get_balance: nominalAsli,
      provider_amount: paymentData.amount || providerAmount,
      provider: "xs-pedia",
      provider_id: trxId,
      provider_reference_id: trxId,
      provider_status: paymentData.status || "pending",
      provider_time: null,
      provider_expires_at: pExpiresAt,
      expires_in_ms: paymentData.expiresInMs || 900000,
      metode: "QRIS",
      status: "pending",
      qr_image: compositeQrUrl,
      qr_image_raw: rawQrImage,
      qris_string: qrisString,
      bg_image: bgUrl,
      created_at: pCreatedAt
    };

    await tambahHistoryDeposit(user._id, history);

    res.status(200).json({
      success: true,
      message: "QRIS berhasil dibuat.",
      data: {
        id: trxId,
        trx_id: trxId,
        reference_id: trxId,
        metode: "QRIS",
        nominal: nominalAsli,
        kode_unik: kodeUnik,
        tambahan: kodeUnik,
        fee: kodeUnik,
        fee_env: kodeUnik,
        fee_provider: 0,
        total_amount: providerAmount,
        get_balance: nominalAsli,
        qr_image: compositeQrUrl,
        qr_image_combined: compositeQrUrl,
        qr_image_raw: rawQrImage,
        qris_string: qrisString,
        bg_image: bgUrl,
        status: paymentData.status || "pending",
        created_at: pCreatedAt,
        expires_at: pExpiresAt,
        expires_in_ms: paymentData.expiresInMs || 900000
      }
    });

    // ================= POLLING OTOMATIS =================
    const intervalId = setInterval(async () => {
      try {
        const h = await User.findOne(
          { _id: user._id, "historyDeposit.id": trxId },
          { "historyDeposit.$": 1 }
        );

        const dep = h?.historyDeposit?.[0];
        const localStatus = String(dep?.status || "").toLowerCase();

        if (!dep || !["pending", "processing"].includes(localStatus)) {
          clearInterval(intervalId);
          return;
        }

        const checkUrl = `${XS_PEDIA_BASE_URL}/api/v1/payments/${encodeURIComponent(trxId)}/status`;
        const checkRes = await fetch(checkUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "User-Agent": "Mozilla/5.0"
          },
          body: JSON.stringify({})
        });

        if (!checkRes.ok) return;

        const checkData = await checkRes.json();
        if (!checkData?.success || !checkData?.data) return;

        const providerTrx = checkData.data;
        const rawStatus = String(providerTrx.status || "").toLowerCase();
        const apiStatus = rawStatus === "paid" ? "success" : rawStatus;

        let pPaidAt = providerTrx.paidAt || providerTrx.createdAt || null;
        if (pPaidAt) pPaidAt = new Date(pPaidAt).toISOString();

        if (apiStatus === "success") {
          const updateResult = await User.updateOne(
            {
              _id: user._id,
              historyDeposit: {
                $elemMatch: { id: trxId, status: {$in: ["pending", "processing"] } }
              }
            },
            {
              $set: {
                "historyDeposit.$.status": "success",
                "historyDeposit.$.provider_id": String(providerTrx.id || trxId),
                "historyDeposit.$.provider_reference_id": String(providerTrx.transactionId || providerTrx.id || trxId),
                "historyDeposit.$.provider_amount": Number(providerTrx.amount) || 0,
                "historyDeposit.$.provider_status": apiStatus,
                "historyDeposit.$.provider_time": pPaidAt
              },
              $inc: { saldo: nominalAsli }
            }
          );

          if (updateResult.modifiedCount > 0) {
            console.log(`Deposit SUCCESS ${trxId}`);
          }
          clearInterval(intervalId);
          return;
        }

        if (["failed", "expired", "cancel", "cancelled"].includes(apiStatus)) {
          await User.updateOne(
            {
              _id: user._id,
              historyDeposit: {
                $elemMatch: { id: trxId, status: {$in: ["pending", "processing"] } }
              }
            },
            {
              $set: {
                "historyDeposit.$.status": apiStatus,
                "historyDeposit.$.provider_status": apiStatus,
                "historyDeposit.$.provider_time": pPaidAt
              }
            }
          );
          clearInterval(intervalId);
        }
      } catch (e) {
        console.error("XS-Pedia Polling Error:", e.message);
      }
    }, 10000);

    const timeoutMs = paymentData.expiresInMs || 15 * 60 * 1000;
    setTimeout(() => clearInterval(intervalId), timeoutMs + 60000);

  } catch (error) {
    console.error("XS-Pedia Deposit Create Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
});


// ================= CEK STATUS DEPOSIT XS-PEDIA =================
router.get("/deposit/status", validateApiKey, async (req, res) => {
  const { id } = req.query;
  const { user } = req;

  if (!id) return res.status(400).json({ success: false, message: "ID diperlukan." });
  if (!user?._id) return res.status(401).json({ success: false, message: "User API tidak valid." });

  try {
    let h = await User.findOne(
      { _id: user._id, "historyDeposit.id": id },
      { "historyDeposit.$": 1 }
    );

    if (!h?.historyDeposit?.length) {
      return res.status(404).json({ success: false, message: "Data tidak ditemukan di DB." });
    }

    let dep = h.historyDeposit[0];
    let status = String(dep.status || "pending").toLowerCase();

    if (!["pending", "processing"].includes(status)) {
      const nominal = Number(dep.nominal) || 0;
      const kodeUnik = Number(dep.kode_unik || dep.tambahan || dep.fee) || 0;
      const totalAmount = Number(dep.total_amount) > 0 ? Number(dep.total_amount) : nominal + kodeUnik;

      return res.status(200).json({
        success: true,
        data: {
          id,
          trx_id: id,
          reference_id: dep.reference_id || dep.reff_id || "-",
          nominal,
          kode_unik: kodeUnik,
          tambahan: kodeUnik,
          fee: kodeUnik,
          fee_env: kodeUnik,
          fee_provider: Number(dep.fee_provider) || 0,
          total_amount: totalAmount,
          get_balance: Number(dep.get_balance) || nominal,
          status,
          metode: dep.metode || "QRIS",
          qr_image: dep.qr_image || "",
          qr_image_combined: dep.qr_image || "",
          qr_image_raw: dep.qr_image_raw || "",
          qris_string: dep.qris_string || "",
          bg_image: dep.bg_image || (typeof DEFAULT_BG_URL !== 'undefined' ? DEFAULT_BG_URL : ''),
          created_at: dep.created_at || null,
          expires_at: dep.provider_expires_at || null,
          paid_at: dep.provider_time || null,
          provider_id: dep.provider_id || null,
          provider_reference_id: dep.provider_reference_id || null,
          provider_amount: Number(dep.provider_amount) || totalAmount,
          provider_status: dep.provider_status || null,
          provider_time: dep.provider_time || null
        }
      });
    }

    const targetPaymentId = dep.provider_id || id;
    const detailUrl = `${XS_PEDIA_BASE_URL}/api/v1/payments/${encodeURIComponent(targetPaymentId)}/status`;

    let checkRes;
    try {
      checkRes = await fetch(detailUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0"
        },
        body: JSON.stringify({})
      });
    } catch (e) {
      console.error("XS-Pedia Status Fetch Error:", e);
      return res.status(502).json({ success: false, message: "Koneksi ke XS-Pedia gagal." });
    }

    if (checkRes && checkRes.ok) {
      const responseText = await checkRes.text();
      let result;

      try {
        result = JSON.parse(responseText);
      } catch (e) {
        console.error("XS-Pedia Status Invalid JSON:", responseText.slice(0, 500));
        return res.status(502).json({ success: false, message: "Response status XS-Pedia bukan JSON." });
      }

      if (result?.success && result?.data) {
        const providerTrx = result.data;
        const rawStatus = String(providerTrx.status || status).toLowerCase();
        const providerStatus = rawStatus === "paid" ? "success" : rawStatus;

        const pId = String(providerTrx.id || targetPaymentId);
        const pRef = String(providerTrx.transactionId || providerTrx.reference_id || pId);

        let pPaidAt = providerTrx.paidAt || providerTrx.createdAt || null;
        if (pPaidAt) pPaidAt = new Date(pPaidAt).toISOString();

        let pExpiresAt = providerTrx.expiresAt || null;
        if (pExpiresAt) pExpiresAt = new Date(pExpiresAt).toISOString();

        if (providerStatus === "success") {
          await User.updateOne(
            {
              _id: user._id,
              historyDeposit: {
                $elemMatch: { id, status: {$in: ["pending", "processing"] } }
              }
            },
            {
              $set: {
                "historyDeposit.$.status": "success",
                "historyDeposit.$.provider_id": pId,
                "historyDeposit.$.provider_reference_id": pRef,
                "historyDeposit.$.provider_amount": Number(providerTrx.amount) || 0,
                "historyDeposit.$.provider_status": providerStatus,
                "historyDeposit.$.provider_time": pPaidAt,
                "historyDeposit.$.provider_expires_at": pExpiresAt
              },
              $inc: { saldo: Number(dep.get_balance) || 0 }
            }
          );
          status = "success";
        } else if (["failed", "expired", "cancel", "cancelled"].includes(providerStatus)) {
          await User.updateOne(
            {
              _id: user._id,
              historyDeposit: {
                $elemMatch: { id, status: {$in: ["pending", "processing"] } }
              }
            },
            {
              $set: {
                "historyDeposit.$.status": providerStatus,
                "historyDeposit.$.provider_id": pId,
                "historyDeposit.$.provider_reference_id": pRef,
                "historyDeposit.$.provider_amount": Number(providerTrx.amount) || 0,
                "historyDeposit.$.provider_status": providerStatus,
                "historyDeposit.$.provider_time": pPaidAt,
                "historyDeposit.$.provider_expires_at": pExpiresAt
              }
            }
          );
          status = providerStatus;
        }
      }
    }

    h = await User.findOne(
      { _id: user._id, "historyDeposit.id": id },
      { "historyDeposit.$": 1 }
    );

    dep = h?.historyDeposit?.[0] || dep;
    status = String(dep.status || status || "pending").toLowerCase();

    const nominal = Number(dep.nominal) || 0;
    const kodeUnik = Number(dep.kode_unik || dep.tambahan || dep.fee) || 0;
    const totalAmount = Number(dep.total_amount) > 0 ? Number(dep.total_amount) : nominal + kodeUnik;

    return res.status(200).json({
      success: true,
      data: {
        id,
        trx_id: id,
        reference_id: dep.reference_id || dep.reff_id || "-",
        nominal,
        kode_unik: kodeUnik,
        tambahan: kodeUnik,
        fee: kodeUnik,
        fee_env: kodeUnik,
        fee_provider: Number(dep.fee_provider) || 0,
        total_amount: totalAmount,
        get_balance: Number(dep.get_balance) || nominal,
        status,
        metode: dep.metode || "QRIS",
        qr_image: dep.qr_image || "",
        qr_image_combined: dep.qr_image || "",
        qr_image_raw: dep.qr_image_raw || "",
        qris_string: dep.qris_string || "",
        bg_image: dep.bg_image || (typeof DEFAULT_BG_URL !== 'undefined' ? DEFAULT_BG_URL : ''),
        created_at: dep.created_at || null,
        expires_at: dep.provider_expires_at || null,
        paid_at: dep.provider_time || null,
        provider_id: dep.provider_id || null,
        provider_reference_id: dep.provider_reference_id || null,
        provider_amount: Number(dep.provider_amount) || totalAmount,
        provider_status: dep.provider_status || null,
        provider_time: dep.provider_time || null
      }
    });

  } catch (error) {
    console.error("XS-Pedia Status Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
});



// === ROUTE CANCEL (STRUKTUR ASLI - LOCAL ONLY) ===
router.get("/deposit/cancel", validateApiKey, async (req, res) => {
  const { user } = req;
  const { id } = req.query;
  if (!id) return res.status(400).json({ success: false, message: "ID diperlukan." });

  try {
    const userHistory = await User.findOne({ _id: user._id, "historyDeposit.id": id });
    if (!userHistory) return res.status(404).json({ success: false, message: "Data tidak ditemukan." });

    // Update status di database internal saja
    await editHistoryDeposit(user._id, id, "cancel");

    return res.status(200).json({
      success: true,
      data: { id, status: "cancel" },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});


module.exports = router;
