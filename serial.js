/**
 * serial.js — Web Serial Controller for ESP32 Smart Robot
 * Baud rate: 115200 (matching main.cpp Serial.begin(115200))
 *
 * Commands supported by robot (main.cpp):
 *   LED_ON / LED_OFF  — toggle desk lamp
 *   PHOTO             — trigger camera effect + LED flash
 *   ONE               — run test/effect
 *   DEN / LED         — toggle LED (alias)
 *   (via WebSocket also: PERSON, NOPERSON)
 */

let port = null;
let reader = null;
let writer = null;
let isConnected = false;
let readLoopRunning = false;
let textBuffer = "";

// ---- DOM refs ----
const modal        = document.getElementById("serial-modal");
const btnOpen1     = document.getElementById("open-serial-modal");
const btnOpen2     = document.getElementById("open-serial-modal-2");
const btnClose     = document.getElementById("close-serial-modal");
const btnConnect   = document.getElementById("btn-serial-connect");
const btnDisconnect= document.getElementById("btn-serial-disconnect");
const btnClear     = document.getElementById("btn-clear-log");
const btnSend      = document.getElementById("btn-serial-send");
const textInput    = document.getElementById("serial-text-input");
const terminal     = document.getElementById("serial-terminal");
const statusEl     = document.getElementById("serial-status");
const statusDot    = document.getElementById("serial-dot");
const statusText   = document.getElementById("serial-status-text");
const quickBtns    = document.querySelectorAll(".btn-quick-cmd");

// ---- Modal open/close ----
function openModal() {
  modal.style.display = "flex";
  requestAnimationFrame(() => modal.classList.add("active"));
  if (!("serial" in navigator)) {
    logLine("⚠ Web Serial API is not supported in this browser.", "err");
    logLine("Please use Chrome or Edge on desktop.", "err");
    btnConnect.disabled = true;
  } else {
    logLine("Ready. Click ⚡ Connect USB to start.", "sys");
  }
}

function closeModal() {
  modal.classList.remove("active");
  setTimeout(() => { modal.style.display = "none"; }, 200);
}

btnOpen1?.addEventListener("click", openModal);
btnOpen2?.addEventListener("click", openModal);
btnClose?.addEventListener("click", closeModal);
modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

// ---- Terminal logging ----
function logLine(text, type = "rx") {
  const line = document.createElement("div");
  line.className = `terminal-line ${type}`;
  const now = new Date();
  const ts = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}:${String(now.getSeconds()).padStart(2,"0")}`;

  if (type === "tx") {
    line.textContent = `[${ts}] >> ${text}`;
  } else if (type === "sys") {
    line.textContent = `[${ts}] ─ ${text}`;
  } else if (type === "err") {
    line.textContent = `[${ts}] ✕ ${text}`;
  } else {
    line.textContent = `[${ts}] ${text}`;
  }

  terminal.appendChild(line);
  terminal.scrollTop = terminal.scrollHeight;

  // Keep max 400 lines
  while (terminal.children.length > 400) {
    terminal.removeChild(terminal.firstChild);
  }
}

// ---- Set connected state ----
function setConnected(state) {
  isConnected = state;
  statusEl.classList.toggle("connected", state);
  statusText.textContent = state ? "Connected" : "Disconnected";
  btnConnect.disabled    = state;
  btnDisconnect.disabled = !state;
  btnSend.disabled       = !state;
  textInput.disabled     = !state;
  quickBtns.forEach(b => b.disabled = !state);

  if (state) {
    textInput.placeholder = "Type command and press Enter (e.g. LED_ON, PHOTO...)";
    textInput.focus();
  } else {
    textInput.placeholder = "Connect USB first to enable input.";
  }
}

// ---- Connect to serial port ----
btnConnect.addEventListener("click", async () => {
  if (!("serial" in navigator)) return;
  try {
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: 115200 });
    setConnected(true);
    logLine("Connected at 115200 baud.", "sys");
    startReadLoop();
  } catch (err) {
    if (err.name !== "NotFoundError") {
      logLine(`Connection failed: ${err.message}`, "err");
    }
  }
});

// ---- Disconnect ----
btnDisconnect.addEventListener("click", async () => {
  await disconnectPort();
});

async function disconnectPort() {
  readLoopRunning = false;
  try { reader?.cancel(); } catch {}
  try { await reader?.releaseLock(); } catch {}
  try { writer?.close(); } catch {}
  try { writer?.releaseLock(); } catch {}
  try { await port?.close(); } catch {}
  reader = null;
  writer = null;
  port   = null;
  setConnected(false);
  logLine("Disconnected.", "sys");
}

// ---- Read loop: receive data from robot ----
async function startReadLoop() {
  const decoder = new TextDecoder();
  reader = port.readable.getReader();
  readLoopRunning = true;

  try {
    while (readLoopRunning) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        textBuffer += decoder.decode(value, { stream: true });
        const lines = textBuffer.split(/\r?\n/);
        textBuffer = lines.pop() ?? "";
        lines.forEach(l => {
          const trimmed = l.trim();
          if (trimmed.length > 0) logLine(trimmed, "rx");
        });
      }
    }

    const tail = decoder.decode();
    if (tail) {
      const trimmed = tail.trim();
      if (trimmed.length > 0) logLine(trimmed, "rx");
    }
  } catch (err) {
    if (readLoopRunning) logLine(`Read error: ${err.message}`, "err");
  }

  if (isConnected) await disconnectPort();
}

// ---- Send text to robot ----
async function sendCommand(cmd) {
  const command = String(cmd ?? "").trim();
  if (!isConnected || !port?.writable || !command) return;
  try {
    if (!writer) {
      writer = port.writable.getWriter();
    }

    const payload = new TextEncoder().encode(command + "\r\n");
    await writer.write(payload);
    logLine(command, "tx");
  } catch (err) {
    logLine(`Send failed: ${err.message}`, "err");
  }
}

// ---- Input bar: send on Enter or button ----
textInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const val = textInput.value.trim();
    if (val) {
      sendCommand(val);
      textInput.value = "";
    }
  }
});

btnSend.addEventListener("click", () => {
  const val = textInput.value.trim();
  if (val) {
    sendCommand(val);
    textInput.value = "";
  }
});

// ---- Quick command buttons ----
quickBtns.forEach(btn => {
  btn.addEventListener("click", () => {
    // Map display names to actual serial commands
    const cmdMap = {
      "EFFECT": "ONE",   // robot expects "ONE" not "EFFECT"
    };
    const cmd = cmdMap[btn.dataset.cmd] || btn.dataset.cmd;
    if (cmd) sendCommand(cmd);
  });
});

// ---- Clear log ----
btnClear.addEventListener("click", () => {
  terminal.innerHTML = "";
  logLine("Log cleared.", "sys");
});
