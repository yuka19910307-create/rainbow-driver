/**
 * Rainbow Driver Cargo - PRELAUNCH Gmail bridge (Google Apps Script).
 * Sends a six-digit operator-only test verification code to the SCRIPT OWNER.
 * Set no credentials in this source. Never use for general customer intake.
 * Deploy Web App: Execute as "Me"; access "Anyone" (HMAC authenticates calls).
 * MailApp can send messages but cannot read the Gmail inbox.
 *
 * Run setupBridge() once from the script editor, then view Script properties.
 * Copy BRIDGE_HMAC_SECRET to Supabase CARGO_GMAIL_BRIDGE_HMAC_SECRET.
 * Set Supabase CARGO_GMAIL_BRIDGE_URL to your /exec deployment URL.
 * Script property TEST_SEND_ENABLED defaults to NO and must be set to YES
 * only after you verify the script owner and intended recipient.
 */
function setupBridge() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty("BRIDGE_HMAC_SECRET")) {
    // Two independent UUIDs; never print the key in a log.
    var secret = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, "").toLowerCase();
    props.setProperty("BRIDGE_HMAC_SECRET", secret);
  }
  if (!props.getProperty("TEST_SEND_ENABLED")) props.setProperty("TEST_SEND_ENABLED", "NO");
  if (!props.getProperty("OWNER_EMAIL")) {
    var own = Session.getEffectiveUser().getEmail();
    if (own) props.setProperty("OWNER_EMAIL", own.toLowerCase().trim());
  }
  // No secret or recipient values in logs.
  Logger.log("Ready. Configure Script properties and deploy the web app.");
}
function authorizeMail() {
  // Run this from the script editor to grant send-mail permission.
  Logger.log("Mail sending permission granted; remaining daily recipient quota is available.");
  MailApp.getRemainingDailyQuota();
}
function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
function bytesFromHex_(s) {
  if (!/^[0-9a-f]{64}$/.test(s || "")) return null;
  var a = [];
  for (var i = 0; i < s.length; i += 2) {
    var n = parseInt(s.slice(i, i + 2), 16);
    // Apps Script Byte[] uses signed bytes (-128..127).
    a.push(n > 127 ? n - 256 : n);
  }
  return a;
}
/** HMAC interoperability self-test using ONLY a public, fixed test vector. */
function testBridgeHmacBytes() {
  var key = bytesFromHex_("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f");
  var data = Utilities.newBlob("CARGO_HMAC_BYTE_TEST").getBytes();
  var actual = toHex_(Utilities.computeHmacSha256Signature(data, key));
  var expected = "9948ce320bd81e7df47d3d0befef65614c95abea58de95da19bee3a3f4712b7f";
  if (actual !== expected) throw new Error("HMAC Byte[] self-test failed");
  Logger.log("HMAC Byte[] self-test PASS (no private keys used)");
}
function toHex_(a) {
  return a.map(function(b) {return ("0" + (b & 255).toString(16)).slice(-2);}).join("");
}
function same_(a,b) {
  if (!/^[0-9a-f]{64}$/.test(b || "")) return false;
  var x = 0;
  for (var i = 0; i < 64; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}
function doGet() {
  return reply_({ok:false,mode:"CARGO_PRELAUNCH_MAIL_BRIDGE",mail_sent:false});
}
function doPost(e) {
  // GAS web apps do not expose arbitrary custom HTTP auth headers.
  // The entire encoded payload is HMAC-signed and timestamp/nonce checked.
  var props = PropertiesService.getScriptProperties();
  var key = bytesFromHex_(props.getProperty("BRIDGE_HMAC_SECRET"));
  if (!key) return reply_({ok:false,error:"NOT_CONFIGURED"});
  var input;
  try {
    var body = e && e.postData && e.postData.contents;
    if (!body || body.length > 2500) return reply_({ok:false,error:"INVALID_INPUT"});
    input = JSON.parse(body);
    if (!input || input.version !== 1 ||
        typeof input.payload !== "string" ||
        !/^[A-Za-z0-9_-]{20,1500}$/.test(input.payload) ||
        typeof input.signature !== "string") return reply_({ok:false,error:"INVALID_INPUT"});
    var mac = toHex_(Utilities.computeHmacSha256Signature(
      Utilities.newBlob(input.payload).getBytes(), key));
    if (!same_(mac,input.signature)) return reply_({ok:false,error:"UNAUTHORIZED"});
    var decoded = Utilities.newBlob(Utilities.base64DecodeWebSafe(input.payload))
      .getDataAsString("UTF-8");
    var msg = JSON.parse(decoded);
    if (!msg || msg.action !== "send_operator_test" || msg.version !== 1 ||
        typeof msg.nonce !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(msg.nonce) ||
        typeof msg.issued_at !== "number" ||
        Math.abs(Date.now() - msg.issued_at) > 90000 ||
        typeof msg.code !== "string" || !/^[0-9]{6}$/.test(msg.code)) {
      return reply_({ok:false,error:"INVALID_MESSAGE"});
    }
    if (props.getProperty("TEST_SEND_ENABLED") !== "YES")
      return reply_({ok:false,error:"TEST_SEND_DISABLED"});
    // No address is accepted in any HTTP request; send ONLY to the script owner.
    var owner = (props.getProperty("OWNER_EMAIL") || "").toLowerCase().trim();
    var effective = (Session.getEffectiveUser().getEmail() || "").toLowerCase().trim();
    if (!owner || !effective || owner !== effective ||
        !/^[^@\s]+@gmail\.com$/.test(owner))
      return reply_({ok:false,error:"OWNER_EMAIL_INVALID"});
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) return reply_({ok:false,error:"BUSY"});
    try {
      var cache = CacheService.getScriptCache();
      var nonceKey = "cargo_otp_" + msg.nonce;
      if (cache.get(nonceKey)) return reply_({ok:false,error:"REPLAY"});
      // Mark nonce before sending (fail closed when transport result is unknown).
      cache.put(nonceKey,"1",600);
      if (MailApp.getRemainingDailyQuota() < 1)
        return reply_({ok:false,error:"DAILY_QUOTA"});
      var day = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyyMMdd");
      var dayKey = "CARGO_TEST_DAY_" + day;
      var used = Number(props.getProperty(dayKey) || "0");
      if (used >= 10) return reply_({ok:false,error:"TEST_DAY_LIMIT"});
      props.setProperty(dayKey,String(used + 1));
      MailApp.sendEmail({
        to:owner,
        subject:"【Rainbow Driver】本人確認コード（開発テスト）",
        body:"Rainbow Driver 軽貨物アプリの開発テストです。\n\n本人確認コード：" +
          msg.code + "\n\n有効期限は10分です。\nこのメールに心当たりがない場合は、何も操作しないでください。\n\n" +
          "※現在、一般のお客様からの配送受付は停止中です。",
        name:"Rainbow Driver"
      });
      return reply_({ok:true,sent:true,mode:"OPERATOR_SELF_TEST_ONLY"});
    } finally {
      lock.releaseLock();
    }
  } catch (error) {
    // Never log or return the verification code, addresses, secrets, or signed payload.
    return reply_({ok:false,error:"MAIL_SEND_UNAVAILABLE"});
  }
}