// endpoint/nokos.js
// Proxy ke API ditznesia untuk halaman /nokos. API key disimpan di .env (tidak dikirim ke browser).
const express = require("express");
const axios = require("axios");
const router = express.Router();

// Ambil dependency secara lazy agar tidak terkena circular-import saat router
// dipasang dari index.js. Pastikan index.js mengekspor User dan tambahHistoryOrder.
function getMainDependencies() {
  const main = require("../index.js");
  if (!main.User) throw new Error("Model User tidak ditemukan pada export index.js");
  if (typeof main.tambahHistoryOrder !== "function") {
    throw new Error("tambahHistoryOrder tidak ditemukan pada export index.js");
  }
  return { User: main.User, tambahHistoryOrder: main.tambahHistoryOrder };
}

/* ================= KONFIGURASI (.env) =================
   DITZNESIA_API_KEY=xxxxxxxx
   DITZNESIA_BASE_URL=https://www.ditznesia.com/api/dev   (opsional)
   NOKOS_MARKUP_PERCENT=0                                  (opsional, untung dalam %)
   NOKOS_MARKUP_FLAT=0                                     (opsional, untung dalam Rupiah)
*/
const BASE_URL = process.env.DITZNESIA_BASE_URL || "https://www.ditznesia.com/api/dev";
const API_KEY = process.env.DITZNESIA_API_KEY;
const MARKUP_PERCENT = Number(process.env.NOKOS_MARKUP_PERCENT || 0);
const MARKUP_FLAT = Number(process.env.NOKOS_MARKUP_FLAT || 0);
const OPERATOR_SERVERS = ["1", "4", "6"];

const SAFE = /^[\w.\-]{1,64}$/;

/* ---------- helper ---------- */
function needLogin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ success: false, message: "Silakan login terlebih dahulu." });
  }
  next();
}

async function callDitz(path, params = {}) {
  if (!API_KEY) throw Object.assign(new Error("DITZNESIA_API_KEY belum diatur di .env"), { config: true });
  const r = await axios.get(`${BASE_URL}/${path}`, {
    params: { apikey: API_KEY, ...params },
    timeout: 20000,
  });
  return r.data;
}

const withMarkup = (price) =>
  Math.ceil(Number(price || 0) * (1 + MARKUP_PERCENT / 100) + MARKUP_FLAT);

const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}

function validate(q, needCountry) {
  const server = String(q.server || "");
  if (!/^[1-6]$/.test(server)) return { error: "Server tidak valid." };
  const out = { server };
  if (needCountry) {
    const country = String(q.country || "");
    if (!SAFE.test(country)) return { error: "Negara tidak valid." };
    out.country = country;
  }
  return out;
}

function fail(res, err, fallback) {
  console.error("[nokos]", err.config ? err.message : (err.response?.data || err.message));
  if (err.config) return res.status(500).json({ success: false, message: "Konfigurasi server belum lengkap." });
  return res.status(502).json({ success: false, message: fallback });
}

/* ---------- GET /api/nokos/countries?server=6 ---------- */
router.get("/countries", needLogin, async (req, res) => {
  const v = validate(req.query, false);
  if (v.error) return res.status(400).json({ success: false, message: v.error });
  try {
    const data = await cached(`c:${v.server}`, 5 * 60 * 1000, () => callDitz("countries", { server: v.server }));
    res.json(Array.isArray(data) ? data : data.data || []);
  } catch (e) { fail(res, e, "Gagal mengambil daftar negara."); }
});

/* ---------- GET /api/nokos/operators?server=6&country=6 ---------- */
router.get("/operators", needLogin, async (req, res) => {
  const v = validate(req.query, true);
  if (v.error) return res.status(400).json({ success: false, message: v.error });
  try {
    const data = await cached(`o:${v.server}:${v.country}`, 5 * 60 * 1000, () =>
      callDitz("operators", { server: v.server, country: v.country })
    );
    res.json(data);
  } catch (e) { fail(res, e, "Gagal mengambil daftar operator."); }
});

/* ---------- GET /api/nokos/services?server=6&country=6 ---------- */
async function getServices(server, country) {
  const data = await cached(`s:${server}:${country}`, 20 * 1000, () =>
    callDitz("services", { server, country })
  );
  const list = Array.isArray(data) ? data : data.data || [];
  return list.map((s) => ({ ...s, price: withMarkup(s.price) })); // harga jual
}

router.get("/services", needLogin, async (req, res) => {
  const v = validate(req.query, true);
  if (v.error) return res.status(400).json({ success: false, message: v.error });
  try {
    res.json(await getServices(v.server, v.country));
  } catch (e) { fail(res, e, "Gagal mengambil daftar layanan."); }
});

/* ---------- POST /api/nokos/order ----------
   body: { server, country, service, provider?, operator?, qty? }
   Alur: cek harga di server -> potong saldo -> order ke ditznesia -> catat history.
   Jika order ditolak, saldo dikembalikan otomatis.
*/
function isOk(d) {
  if (!d || typeof d !== "object") return false;
  if (d.success === false || d.status === false || d.error) return false;
  const st = String(d.status ?? "").toLowerCase();
  if (["error", "failed", "gagal", "false"].includes(st)) return false;
  return true;
}
const pick = (d, keys) => {
  for (const k of keys) {
    const val = d?.[k] ?? d?.data?.[k] ?? d?.result?.[k];
    if (val !== undefined && val !== null && val !== "") return val;
  }
  return null;
};

router.post("/order", needLogin, async (req, res) => {
  const v = validate(req.body, true);
  if (v.error) return res.status(400).json({ success: false, message: v.error });

  const service = String(req.body.service || "");
  if (!SAFE.test(service)) return res.status(400).json({ success: false, message: "Layanan tidak valid." });
  const provider = req.body.provider != null && req.body.provider !== "" ? String(req.body.provider) : null;
  if (provider && !SAFE.test(provider)) return res.status(400).json({ success: false, message: "Provider tidak valid." });
  const operator = OPERATOR_SERVERS.includes(v.server) && SAFE.test(String(req.body.operator || ""))
    ? String(req.body.operator) : null;
  const qty = Math.min(5, Math.max(1, parseInt(req.body.qty, 10) || 1));

  const userId = req.session.userId;
  let User, tambahHistoryOrder;
  try {
    ({ User, tambahHistoryOrder } = getMainDependencies());
  } catch (e) {
    console.error("[nokos] dependency error:", e.message);
    return res.status(500).json({ success: false, message: "Konfigurasi model server belum benar." });
  }
  if (userId === "custom-admin") return res.status(403).json({ success: false, message: "Akun admin tidak bisa membeli." });

  let item;
  try {
    cache.delete(`s:${v.server}:${v.country}`); // harga & stok terbaru
    const list = await getServices(v.server, v.country);
    item = list.find((s) => String(s.id) === service && (provider == null || String(s.provider) === provider));
  } catch (e) { return fail(res, e, "Gagal mengecek harga layanan."); }

  if (!item) return res.status(404).json({ success: false, message: "Layanan tidak ditemukan." });
  if (Number(item.count ?? 0) < 1) return res.status(400).json({ success: false, message: "Stok habis." });

  const price = Number(item.price);
  const name = item.service_name || item.produk || item.id;
  const orders = [];
  let message = null;

  for (let i = 0; i < qty; i++) {
    // 1) potong saldo secara atomik (tidak bisa minus)
    const paid = await User.findOneAndUpdate(
      { _id: userId, saldo: { $gte: price } },
      { $inc: { saldo: -price } },
      { new: true }
    );
    if (!paid) { message = "Saldo tidak cukup."; break; }

    // 2) order ke ditznesia
    const params = { server: v.server, country: v.country, service };
    if (operator) params.operator = operator;
    if (provider) params.provider = provider;

    let data = null, pending = false, refund = false;
    try {
      data = await callDitz("order", params);
      if (!isOk(data)) { refund = true; message = data?.message || data?.msg || "Order ditolak provider."; }
    } catch (e) {
      console.error("[nokos] order error:", e.response?.data || e.message);
      if (e.response) { refund = true; message = e.response.data?.message || "Order ditolak provider."; }
      else { pending = true; message = "Koneksi ke provider terputus, cek Riwayat sebelum mencoba lagi."; }
    }

    if (refund) {
      await User.findByIdAndUpdate(userId, { $inc: { saldo: price } });
      break;
    }

    // 3) catat history
    const orderId = String(pick(data, ["id", "order_id", "orderId"]) || `NK${Date.now()}${i}`);
    const number = pick(data, ["number", "phone", "nomor"]);
    try {
      await tambahHistoryOrder(userId, {
        id: orderId,
        reff_id: `NOKOS-${Date.now()}-${i}`,
        layanan: `${name} (S${v.server})`,
        code: service,
        target: number ? String(number) : "-",
        price,
        status: "pending",
        created_at: new Date(),
      });
    } catch (e) { console.error("[nokos] gagal catat history:", e.message); }

    orders.push({ id: orderId, number, pending, raw: data });
    if (pending) break;
  }

  const me = await User.findById(userId).select("saldo");
  const ok = orders.length > 0;
  res.status(ok ? 200 : 400).json({
    success: ok,
    message: ok ? (message || "Pesanan dibuat.") : (message || "Pesanan gagal."),
    orders,
    saldo: me ? me.saldo : null,
  });
});

module.exports = router;
