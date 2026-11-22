package de.example.securityops.security

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class Session(
    val sessionCookie: String,
    val csrfToken: String,
    val deviceId: String,
    val userId: String,
    val tenantId: String,
    val email: String,
    val role: String,
)

class SecureSessionStore(private val context: Context) {
    private val preferences = context.getSharedPreferences("securityops_secure_session", Context.MODE_PRIVATE)
    private val keyAlias = "securityops-session-key"

    fun read(): Session? = runCatching {
        val encoded = preferences.getString("session", null) ?: return null
        val payload = encoded.split('.', limit = 2)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(payload[0], Base64.NO_WRAP)))
        val json = JSONObject(String(cipher.doFinal(Base64.decode(payload[1], Base64.NO_WRAP)), StandardCharsets.UTF_8))
        Session(json.getString("sessionCookie"), json.getString("csrfToken"), json.getString("deviceId"),
            json.getString("userId"), json.getString("tenantId"), json.getString("email"), json.getString("role"))
    }.getOrNull()

    fun write(session: Session) {
        val json = JSONObject().apply {
            put("sessionCookie", session.sessionCookie); put("csrfToken", session.csrfToken)
            put("deviceId", session.deviceId); put("userId", session.userId)
            put("tenantId", session.tenantId); put("email", session.email); put("role", session.role)
        }.toString().toByteArray(StandardCharsets.UTF_8)
        val iv = ByteArray(12).also { java.security.SecureRandom().nextBytes(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key(), GCMParameterSpec(128, iv))
        preferences.edit().putString("session",
            "${Base64.encodeToString(iv, Base64.NO_WRAP)}.${Base64.encodeToString(cipher.doFinal(json), Base64.NO_WRAP)}").apply()
    }

    fun clear() = preferences.edit().remove("session").apply()

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(keyAlias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(keyAlias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setUserAuthenticationRequired(false).build())
        }.generateKey()
    }

    fun deviceId(): String {
        read()?.deviceId?.let { return it }
        val deviceId = preferences.getString("device_id", null) ?: UUID.randomUUID().toString()
        preferences.edit().putString("device_id", deviceId).apply()
        return deviceId
    }
}
