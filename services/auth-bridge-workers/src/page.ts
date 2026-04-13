/**
 * Inlined auth page HTML.
 *
 * Workers have no filesystem — the HTML is embedded as a string constant.
 * This is the same content as services/auth-bridge/static/index.html.
 *
 * {{TOKEN}} and {{BASE_URL}} are replaced at serve time.
 */

export const AUTH_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FlowHelm — Authenticate</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f1117;
      color: #e1e4e8;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      padding: 20px;
    }

    .container {
      max-width: 480px;
      width: 100%;
    }

    h1 {
      font-size: 1.5rem;
      font-weight: 600;
      margin-bottom: 8px;
      color: #f0f3f6;
    }

    .subtitle {
      color: #8b949e;
      margin-bottom: 24px;
      font-size: 0.95rem;
      line-height: 1.5;
    }

    .steps {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 24px;
    }

    .step {
      display: flex;
      gap: 12px;
      margin-bottom: 16px;
    }

    .step:last-child { margin-bottom: 0; }

    .step-num {
      flex-shrink: 0;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: #21262d;
      border: 1px solid #30363d;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.85rem;
      font-weight: 600;
      color: #8b949e;
    }

    .step-content { flex: 1; }

    .step-content p {
      font-size: 0.9rem;
      line-height: 1.5;
      color: #c9d1d9;
    }

    code {
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 4px;
      padding: 2px 6px;
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 0.85rem;
      color: #79c0ff;
    }

    .input-group {
      margin-bottom: 16px;
    }

    label {
      display: block;
      font-size: 0.85rem;
      font-weight: 500;
      color: #8b949e;
      margin-bottom: 6px;
    }

    textarea {
      width: 100%;
      height: 80px;
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 6px;
      color: #e1e4e8;
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 0.85rem;
      padding: 10px;
      resize: vertical;
    }

    textarea:focus {
      outline: none;
      border-color: #58a6ff;
      box-shadow: 0 0 0 3px rgba(88, 166, 255, 0.15);
    }

    button {
      width: 100%;
      padding: 12px;
      border: none;
      border-radius: 6px;
      font-size: 0.95rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s;
    }

    button.primary {
      background: #238636;
      color: #fff;
    }

    button.primary:hover { background: #2ea043; }
    button.primary:disabled {
      background: #21262d;
      color: #484f58;
      cursor: not-allowed;
    }

    .status {
      margin-top: 16px;
      padding: 12px;
      border-radius: 6px;
      font-size: 0.9rem;
      display: none;
    }

    .status.success {
      display: block;
      background: rgba(35, 134, 54, 0.15);
      border: 1px solid #238636;
      color: #3fb950;
    }

    .status.error {
      display: block;
      background: rgba(248, 81, 73, 0.15);
      border: 1px solid #f85149;
      color: #f85149;
    }

    .security-note {
      margin-top: 24px;
      padding: 12px;
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 6px;
      font-size: 0.8rem;
      color: #8b949e;
      line-height: 1.5;
    }

    .noscript-warning {
      background: rgba(248, 81, 73, 0.15);
      border: 1px solid #f85149;
      color: #f85149;
      padding: 16px;
      border-radius: 6px;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authenticate FlowHelm</h1>
    <p class="subtitle">
      Securely transfer your Claude credentials to your FlowHelm instance.
      All encryption happens in your browser — the server never sees your token.
    </p>

    <noscript>
      <div class="noscript-warning">
        <p>JavaScript is required for secure credential transfer.</p>
        <p style="margin-top: 8px;">
          Alternatively, paste the token directly into your FlowHelm terminal.
        </p>
      </div>
    </noscript>

    <div id="app">
      <div class="steps">
        <div class="step">
          <div class="step-num">1</div>
          <div class="step-content">
            <p>On a machine with Claude Code installed, run:</p>
            <p style="margin-top: 6px;"><code>claude setup-token</code></p>
          </div>
        </div>
        <div class="step">
          <div class="step-num">2</div>
          <div class="step-content">
            <p>Copy the token that is displayed.</p>
          </div>
        </div>
        <div class="step">
          <div class="step-num">3</div>
          <div class="step-content">
            <p>Paste it below and click <strong>Connect</strong>.</p>
          </div>
        </div>
      </div>

      <div class="input-group">
        <label for="token-input">Claude Setup Token</label>
        <textarea id="token-input" placeholder="Paste your token here..." spellcheck="false"></textarea>
      </div>

      <button id="connect-btn" class="primary" disabled>Connect</button>

      <div id="status" class="status"></div>

      <div class="security-note">
        Your token is encrypted end-to-end using X25519 key exchange and AES-256-GCM.
        The encryption key is derived from a keypair generated by your FlowHelm instance.
        This page cannot read the private key — only the public key is passed via the
        URL fragment (which is never sent to the server).
      </div>
    </div>
  </div>

  <script>
    (function() {
      'use strict';

      var TOKEN = '{{TOKEN}}';
      var BASE_URL = '{{BASE_URL}}';
      var tokenInput = document.getElementById('token-input');
      var connectBtn = document.getElementById('connect-btn');
      var statusEl = document.getElementById('status');

      var hash = window.location.hash;
      var pkMatch = hash.match(/pk=([^&]+)/);

      if (!pkMatch) {
        showError('Missing public key. Please scan the QR code again from your FlowHelm terminal.');
        connectBtn.disabled = true;
        tokenInput.disabled = true;
        return;
      }

      var vmPublicKeyB64 = decodeURIComponent(pkMatch[1]);

      tokenInput.addEventListener('input', function() {
        connectBtn.disabled = !this.value.trim();
      });

      connectBtn.addEventListener('click', async function() {
        var plaintext = tokenInput.value.trim();
        if (!plaintext) return;

        connectBtn.disabled = true;
        connectBtn.textContent = 'Encrypting...';

        try {
          await encryptAndSubmit(plaintext, vmPublicKeyB64);
          showSuccess('Token encrypted and sent. Check your FlowHelm terminal.');
          tokenInput.disabled = true;
        } catch (err) {
          showError('Encryption failed: ' + err.message);
          connectBtn.disabled = false;
          connectBtn.textContent = 'Connect';
        }
      });

      async function encryptAndSubmit(plaintext, vmPubKeyB64) {
        var vmPubKeyBytes = base64ToBytes(vmPubKeyB64);

        var vmPubKey = await crypto.subtle.importKey(
          'raw', vmPubKeyBytes, { name: 'X25519' }, false, []
        );

        var ephKeyPair = await crypto.subtle.generateKey(
          { name: 'X25519' }, true, ['deriveBits']
        );

        var sharedBits = await crypto.subtle.deriveBits(
          { name: 'X25519', public: vmPubKey },
          ephKeyPair.privateKey, 256
        );

        var aesKey = await crypto.subtle.importKey(
          'raw', sharedBits, { name: 'AES-GCM' }, false, ['encrypt']
        );

        var nonce = crypto.getRandomValues(new Uint8Array(12));
        var encoded = new TextEncoder().encode(plaintext);
        var ciphertext = await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv: nonce }, aesKey, encoded
        );

        var ephPubKeyBytes = await crypto.subtle.exportKey('raw', ephKeyPair.publicKey);

        var response = await fetch(BASE_URL + '/api/session/' + TOKEN, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            encrypted: bytesToBase64(new Uint8Array(ciphertext)),
            ephemeralPublicKey: bytesToBase64(new Uint8Array(ephPubKeyBytes)),
            nonce: bytesToBase64(nonce),
          }),
        });

        if (!response.ok) {
          var data = await response.json().catch(function() { return {}; });
          throw new Error(data.error || 'Server error: ' + response.status);
        }
      }

      function base64ToBytes(b64) {
        var binary = atob(b64);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
      }

      function bytesToBase64(bytes) {
        var binary = '';
        for (var i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
      }

      function showSuccess(msg) {
        statusEl.className = 'status success';
        statusEl.textContent = msg;
      }

      function showError(msg) {
        statusEl.className = 'status error';
        statusEl.textContent = msg;
      }
    })();
  </script>
</body>
</html>`;
