// Kyber KEM bridge for browser using emscripten MODULARIZE build (KyberModule)
// Expected API:
// - await Kyber.ready()
// - await Kyber.keypair() -> { publicKey, secretKey }
// - await Kyber.encapsulate(peerPk) -> { ciphertext, sharedSecret }
// - await Kyber.decapsulate(ct, sk) -> sharedSecret

window.Kyber = (function () {
  let Module = null;
  let cfun = {};
  let sizes = { pk: 0, sk: 0, ct: 0, ss: 32 };
  let initialized = false;
  
  // sizes를 전역에서 접근할 수 있도록 설정
  window.KyberSizes = sizes;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      // cache-busting to avoid stale loader
      const qs = src.includes('?') ? `&t=${Date.now()}` : `?t=${Date.now()}`;
      s.src = `${src}${qs}`;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = (e) => reject(e);
      document.head.appendChild(s);
    });
  }

  async function ready() {
    if (initialized) return true;
    // Prefer modularized kyber_kem.js if present
    try {
      await loadScript('kyber_kem.js');
      if (typeof KyberModule !== 'function') {
        console.error('KyberModule not a function. Global is:', typeof KyberModule);
        return false;
      }
      Module = await KyberModule({
        locateFile: (path) => {
          if (path.endsWith('kyber_kem.wasm')) return `kyber_kem.wasm?t=${Date.now()}`;
          return path;
        }
      }).catch((e) => {
        console.error('KyberModule init failed:', e);
        throw e;
      });
      
      console.log('Module 초기화 완료');
      // Bind C functions
      cfun.keypair = Module.cwrap('kyber_keypair', 'number', ['number', 'number']);
      cfun.encaps = Module.cwrap('kyber_encapsulate', 'number', ['number', 'number', 'number']);
      cfun.decaps = Module.cwrap('kyber_decapsulate', 'number', ['number', 'number', 'number']);
      cfun.get_pk = Module.cwrap('kyber_get_pk_bytes', 'number', []);
      cfun.get_sk = Module.cwrap('kyber_get_sk_bytes', 'number', []);
      cfun.get_ct = Module.cwrap('kyber_get_ct_bytes', 'number', []);
      cfun.get_ss = Module.cwrap('kyber_get_ss_bytes', 'number', []);

      // Some builds may not expose getters; fallback to Kyber-512 defaults
      const pk_size = cfun.get_pk ? cfun.get_pk() : 0;
      const sk_size = cfun.get_sk ? cfun.get_sk() : 0;
      const ct_size = cfun.get_ct ? cfun.get_ct() : 0;
      const ss_size = cfun.get_ss ? cfun.get_ss() : 0;
      
      console.log('Kyber sizes from WASM:', { pk: pk_size, sk: sk_size, ct: ct_size, ss: ss_size });
      
      sizes.pk = pk_size || 800;
      sizes.sk = sk_size || 1632;
      sizes.ct = ct_size || 768;
      sizes.ss = ss_size || 32;
      
      console.log('Kyber sizes (with defaults):', sizes);
      
      initialized = true;
      return true;
    } catch (e) {
      console.error('Kyber ready() failed:', e);
      return false;
    }
  }

  function heapAlloc(n) {
    const ptr = Module._malloc(n);
    const view = new Uint8Array(n);
    
    return { 
      ptr, 
      view,
      writeToWasm: function() {
        if (Module.HEAPU8 && ptr !== 0) {
          Module.HEAPU8.set(view, ptr);
        } else {
          throw new Error('WASM 메모리 쓰기 실패');
        }
      },
      readFromWasm: function() {
        if (Module.HEAPU8 && ptr !== 0) {
          view.set(Module.HEAPU8.subarray(ptr, ptr + n));
        } else {
          throw new Error('WASM 메모리 읽기 실패');
        }
      }
    };
  }

  async function keypair() {
    if (!initialized) throw new Error('Kyber not ready');
    
    const pk = heapAlloc(sizes.pk);
    const sk = heapAlloc(sizes.sk);
    
    const rc = cfun.keypair(pk.ptr, sk.ptr);
    if (rc !== 0) throw new Error('kyber_keypair failed');
    
    pk.readFromWasm();
    sk.readFromWasm();
    
    const out = {
      publicKey: new Uint8Array(pk.view),
      secretKey: new Uint8Array(sk.view)
    };
    
    Module._free(pk.ptr); Module._free(sk.ptr);
    return out;
  }

  async function encapsulate(peerPublicKey) {
    if (!initialized) throw new Error('Kyber not ready');
    
    const ct = heapAlloc(sizes.ct);
    const ss = heapAlloc(sizes.ss);
    const pk = heapAlloc(sizes.pk);
    
    pk.view.set(peerPublicKey);
    pk.writeToWasm();
    
    const rc = cfun.encaps(ct.ptr, ss.ptr, pk.ptr);
    Module._free(pk.ptr);
    
    if (rc !== 0) { 
      Module._free(ct.ptr); 
      Module._free(ss.ptr); 
      throw new Error('kyber_encapsulate failed'); 
    }
    
    ct.readFromWasm();
    ss.readFromWasm();
    
    const out = { 
      ciphertext: new Uint8Array(ct.view), 
      sharedSecret: new Uint8Array(ss.view) 
    };
    
    Module._free(ct.ptr); 
    Module._free(ss.ptr);
    return out;
  }

  async function decapsulate(ciphertext, secretKey) {
    if (!initialized) throw new Error('Kyber not ready');
    
    const ss = heapAlloc(sizes.ss);
    const ct = heapAlloc(sizes.ct);
    const sk = heapAlloc(sizes.sk);
    
    ct.view.set(ciphertext);
    sk.view.set(secretKey);
    ct.writeToWasm();
    sk.writeToWasm();
    
    const rc = cfun.decaps(ss.ptr, ct.ptr, sk.ptr);
    Module._free(ct.ptr); 
    Module._free(sk.ptr);
    
    if (rc !== 0) { 
      Module._free(ss.ptr); 
      throw new Error('kyber_decapsulate failed'); 
    }
    
    ss.readFromWasm();
    const out = new Uint8Array(ss.view);
    Module._free(ss.ptr);
    return out;
  }

  // 메시지 직접 암호화 (상대방 공개키 사용) - Kyber 방식
  async function encrypt(peerPublicKey, message) {
    if (!initialized) throw new Error('Kyber not ready');
    
    const { ciphertext, sharedSecret } = await encapsulate(peerPublicKey);
    const messageBytes = new TextEncoder().encode(message);
    
    const encryptedMessage = new Uint8Array(messageBytes.length);
    for (let i = 0; i < messageBytes.length; i++) {
      const keyByte = sharedSecret[i % sharedSecret.length] ^ 
                     sharedSecret[(i + 1) % sharedSecret.length] ^ 
                     sharedSecret[(i + 2) % sharedSecret.length];
      encryptedMessage[i] = messageBytes[i] ^ keyByte;
    }
    
    const result = new Uint8Array(ciphertext.length + encryptedMessage.length);
    result.set(ciphertext, 0);
    result.set(encryptedMessage, ciphertext.length);
    return result;
  }
  
  // 메시지 직접 복호화 (내 비밀키 사용) - Kyber 방식
  async function decrypt(encryptedData, mySecretKey) {
    if (!initialized) throw new Error('Kyber not ready');
    
    const kyberCiphertextLength = sizes.ct || 768;
    
    if (encryptedData.length < kyberCiphertextLength) {
      throw new Error(`암호화된 데이터가 너무 짧습니다. 예상: ${kyberCiphertextLength}, 실제: ${encryptedData.length}`);
    }
    
    const ciphertext = encryptedData.slice(0, kyberCiphertextLength);
    const encryptedMessage = encryptedData.slice(kyberCiphertextLength);
    const sharedSecret = await decapsulate(ciphertext, mySecretKey);
    
    const decryptedMessage = new Uint8Array(encryptedMessage.length);
    for (let i = 0; i < encryptedMessage.length; i++) {
      const keyByte = sharedSecret[i % sharedSecret.length] ^ 
                     sharedSecret[(i + 1) % sharedSecret.length] ^ 
                     sharedSecret[(i + 2) % sharedSecret.length];
      decryptedMessage[i] = encryptedMessage[i] ^ keyByte;
    }
    
    return new TextDecoder().decode(decryptedMessage);
  }

  return { ready, keypair, encapsulate, decapsulate, encrypt, decrypt };
})();


