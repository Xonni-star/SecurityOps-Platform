package de.example.securityops.network

import android.content.Context
import de.example.securityops.BuildConfig
import de.example.securityops.data.OutboxDao
import de.example.securityops.data.OutboxEntity
import de.example.securityops.security.SecureSessionStore
import de.example.securityops.security.Session
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID

class SecurityOpsApi(
    private val context: Context,
    private val sessionStore: SecureSessionStore,
    private val outbox: OutboxDao,
) {
    suspend fun login(email: String, password: String): Session = withContext(Dispatchers.IO) {
        val deviceId = sessionStore.deviceId()
        val body = JSONObject().apply {
            put("email", email); put("password", password); put("device_id", deviceId)
            put("metadata", JSONObject().put("platform", "android").put("app_version", BuildConfig.VERSION_NAME))
        }
        val connection = request("/auth/login", "POST", body.toString(), null)
        if (connection.responseCode !in 200..299) error(connection.errorStream?.bufferedReader()?.readText() ?: "Anmeldung fehlgeschlagen")
        val response = JSONObject(connection.inputStream.bufferedReader().readText())
        if (response.optBoolean("mfa_pending")) {
            error("MFA ist für dieses Konto erforderlich; der native MFA-Dialog ist noch nicht freigeschaltet")
        }
        val cookies = connection.headerFields["Set-Cookie"].orEmpty().joinToString(";")
        val sessionCookie = cookies.substringAfter("securityops_session=", "").substringBefore(";")
        val csrfCookie = cookies.substringAfter("securityops_csrf=", "").substringBefore(";")
        if (sessionCookie.isBlank() || csrfCookie.isBlank()) error("Server lieferte keine sichere Session zurück")
        val user = response.getJSONObject("user")
        Session(sessionCookie, csrfCookie, deviceId, user.getString("id"), user.getString("tenantId"),
            user.getString("email"), user.getString("role")).also(sessionStore::write)
    }

    suspend fun logout() = withContext(Dispatchers.IO) {
        runCatching { request("/auth/logout", "POST", "{}", sessionStore.read()).disconnect() }
    }

    suspend fun submitPatrolScan(routeId: String, employeeId: String, nfcUid: String) {
        val payload = JSONObject().apply {
            put("nfc_uid", nfcUid); put("employee_id", employeeId)
            put("scanned_at", SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).format(Date()))
            put("client_event_id", UUID.randomUUID().toString())
        }
        submitOrQueue("/patrol-routes/$routeId/scans", "patrol.scan", payload)
    }

    suspend fun submitPanic(description: String) {
        val payload = JSONObject().apply {
            put("description", description); put("position", "android-device")
            put("client_event_id", UUID.randomUUID().toString())
        }
        submitOrQueue("/alarms/panic", "alarms.panic", payload)
    }

    private suspend fun submitOrQueue(path: String, action: String, payload: JSONObject) = withContext(Dispatchers.IO) {
        val session = sessionStore.read() ?: error("Anmeldung erforderlich")
        if (!isOnline()) {
            outbox.insert(OutboxEntity(action = action, path = path, payload = payload.toString()))
            return@withContext
        }
        val connection = request(path, "POST", payload.toString(), session, payload.getString("client_event_id"))
        if (connection.responseCode !in 200..299) {
            if (connection.responseCode == 409) error("Serverkonflikt: Vorgang wurde nicht stillschweigend wiederholt")
            outbox.insert(OutboxEntity(action = action, path = path, payload = payload.toString(),
                lastError = "HTTP ${connection.responseCode}"))
            error("Server nicht erreichbar; Vorgang liegt in der Offline-Outbox")
        }
    }

    internal fun request(
        path: String,
        method: String,
        body: String,
        session: Session?,
        idempotencyKey: String? = null,
    ): HttpURLConnection {
        val connection = URL(BuildConfig.SECURITYOPS_API_BASE_URL.trimEnd('/') + path).openConnection() as HttpURLConnection
        connection.requestMethod = method
        connection.connectTimeout = 15_000
        connection.readTimeout = 20_000
        connection.setRequestProperty("Content-Type", "application/json")
        session?.let {
            connection.setRequestProperty("Cookie", "securityops_session=${it.sessionCookie}; securityops_csrf=${it.csrfToken}")
            connection.setRequestProperty("X-CSRF-Token", it.csrfToken)
        }
        idempotencyKey?.let { connection.setRequestProperty("Idempotency-Key", it) }
        connection.doInput = true
        if (method != "GET") {
            connection.doOutput = true
            connection.outputStream.bufferedWriter().use { it.write(body) }
        }
        return connection
    }

    private fun isOnline(): Boolean {
        val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as android.net.ConnectivityManager
        return manager.activeNetwork != null
    }
}
