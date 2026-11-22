package de.example.securityops.sync

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import de.example.securityops.data.MobileDatabase
import de.example.securityops.network.SecurityOpsApi
import de.example.securityops.security.SecureSessionStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val db = MobileDatabase.create(applicationContext)
        val dao = db.outboxDao()
        val api = SecurityOpsApi(applicationContext, SecureSessionStore(applicationContext), dao)
        for (item in dao.pending()) {
            runCatching {
                val session = SecureSessionStore(applicationContext).read() ?: error("Session abgelaufen")
                val payload = JSONObject(item.payload)
                val connection = api.request(
                    item.path,
                    "POST",
                    item.payload,
                    session,
                    payload.optString("client_event_id").takeIf { it.isNotBlank() },
                )
                if (connection.responseCode == 409) {
                    dao.mark(item.id, "conflict", "Serverkonflikt; manuelle Prüfung erforderlich")
                    return@runCatching
                }
                if (connection.responseCode !in 200..299) error("HTTP ${connection.responseCode}")
                dao.delete(item.id)
            }.onFailure { dao.mark(item.id, "pending", it.message) }
        }
        Result.success()
    }
}

object SyncScheduler {
    fun ensurePeriodic(context: Context) {
        val constraints = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            "securityops-outbox-periodic", ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES).setConstraints(constraints).build(),
        )
    }

    fun runNow(context: Context) {
        WorkManager.getInstance(context).enqueueUniqueWork(
            "securityops-outbox-now", ExistingWorkPolicy.REPLACE,
            OneTimeWorkRequestBuilder<SyncWorker>().setConstraints(
                Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build(),
            ).build(),
        )
    }
}
