/**
 * ChatCrypto - Encryption utilities for SkateChat
 * Handles all cryptographic operations
 */

const ChatCrypto = {
    /**
     * Generate a new keypair for this session
     */
    generateKeypair() {
        const privateKey = new Uint8Array(32);
        crypto.getRandomValues(privateKey);
        
        // Derive public key (simplified - real impl would use secp256k1)
        const publicKey = this._derivePublicKey(privateKey);
        
        return { private: privateKey, public: publicKey };
    },
    
    /**
     * Generate random hex string
     */
    randomHex(bytes = 32) {
        const arr = new Uint8Array(bytes);
        crypto.getRandomValues(arr);
        return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
    },
    
    /**
     * Generate a group secret (with optional password)
     */
    generateGroupSecret(password = null) {
        const baseSecret = this.randomHex(32);
        
        if (password) {
            // Mix password into the secret
            return this._mixPassword(baseSecret, password);
        }
        
        return baseSecret;
    },
    
    /**
     * Derive group ID from secret (public identifier)
     */
    deriveGroupId(secret) {
        return this._hash(secret).slice(0, 16);
    },
    
    /**
     * Apply password to a group secret for joining
     */
    applyPassword(baseSecret, password) {
        return this._mixPassword(baseSecret, password);
    },
    
    /**
     * Encrypt message with group key
     */
    encrypt(plaintext, groupKey) {
        try {
            const keyBytes = this._hexToBytes(groupKey);
            const textBytes = new TextEncoder().encode(plaintext);
            
            // Generate random IV
            const iv = new Uint8Array(16);
            crypto.getRandomValues(iv);
            
            // XOR encryption with key expansion
            const encrypted = new Uint8Array(textBytes.length);
            for (let i = 0; i < textBytes.length; i++) {
                const keyByte = keyBytes[(i + iv[i % 16]) % keyBytes.length];
                encrypted[i] = textBytes[i] ^ keyByte ^ iv[i % 16];
            }
            
            // Prepend IV to ciphertext
            const combined = new Uint8Array(iv.length + encrypted.length);
            combined.set(iv);
            combined.set(encrypted, iv.length);
            
            return btoa(String.fromCharCode(...combined));
        } catch (e) {
            console.error('[ChatCrypto] Encrypt error:', e);
            return null;
        }
    },
    
    /**
     * Decrypt message with group key
     */
    decrypt(ciphertext, groupKey) {
        try {
            const keyBytes = this._hexToBytes(groupKey);
            const combined = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));
            
            // Extract IV and ciphertext
            const iv = combined.slice(0, 16);
            const encrypted = combined.slice(16);
            
            // XOR decryption
            const decrypted = new Uint8Array(encrypted.length);
            for (let i = 0; i < encrypted.length; i++) {
                const keyByte = keyBytes[(i + iv[i % 16]) % keyBytes.length];
                decrypted[i] = encrypted[i] ^ keyByte ^ iv[i % 16];
            }
            
            return new TextDecoder().decode(decrypted);
        } catch (e) {
            return null;
        }
    },
    
    /**
     * Create DM encryption key between two users
     */
    createDMKey(myPrivate, theirPublic) {
        // Simplified ECDH - in production use proper curve
        const combined = this._bytesToHex(myPrivate) + theirPublic;
        return this._hash(combined);
    },
    
    // ========== PRIVATE HELPERS ==========
    
    _derivePublicKey(privateKey) {
        // Simplified derivation (real impl uses secp256k1)
        let hash = 0n;
        for (let i = 0; i < privateKey.length; i++) {
            hash = (hash << 8n) | BigInt(privateKey[i]);
            hash = hash % (2n ** 256n);
        }
        return hash.toString(16).padStart(64, '0');
    },
    
    _mixPassword(secret, password) {
        // Hash password and XOR with secret
        const passHash = this._hash(password);
        const secretBytes = this._hexToBytes(secret);
        const passBytes = this._hexToBytes(passHash);
        
        const mixed = new Uint8Array(secretBytes.length);
        for (let i = 0; i < secretBytes.length; i++) {
            mixed[i] = secretBytes[i] ^ passBytes[i % passBytes.length];
        }
        
        return this._bytesToHex(mixed);
    },
    
    _hash(str) {
        // Simple hash function (for demo - production would use SHA-256)
        let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
        for (let i = 0; i < str.length; i++) {
            const ch = str.charCodeAt(i);
            h1 = Math.imul(h1 ^ ch, 2654435761);
            h2 = Math.imul(h2 ^ ch, 1597334677);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
        h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
        h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        
        const result = (BigInt(h2) << 32n) | BigInt(h1 >>> 0);
        return result.toString(16).padStart(16, '0') + 
               this._simpleHash(str + result.toString()).padStart(48, '0');
    },
    
    _simpleHash(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) - hash) + str.charCodeAt(i);
            hash = hash & hash;
        }
        return Math.abs(hash).toString(16);
    },
    
    _hexToBytes(hex) {
        const bytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < hex.length; i += 2) {
            bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
        }
        return bytes;
    },
    
    _bytesToHex(bytes) {
        return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    }
};

if (typeof window !== 'undefined') {
    window.ChatCrypto = ChatCrypto;
}
