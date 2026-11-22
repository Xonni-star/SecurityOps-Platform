package de.example.securityops

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.nfc.NfcAdapter
import android.nfc.Tag
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import de.example.securityops.data.MobileDatabase
import de.example.securityops.network.SecurityOpsApi
import de.example.securityops.security.SecureSessionStore
import de.example.securityops.sync.SyncScheduler
import kotlinx.coroutines.launch

@androidx.compose.material3.ExperimentalMaterial3Api
class MainActivity : ComponentActivity(), NfcAdapter.ReaderCallback {
    private var nfcAdapter: NfcAdapter? = null
    private var onNfcRead: ((String) -> Unit)? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        nfcAdapter = NfcAdapter.getDefaultAdapter(this)
        val sessionStore = SecureSessionStore(this)
        val database = MobileDatabase.create(this)
        val api = SecurityOpsApi(this, sessionStore, database.outboxDao())
        SyncScheduler.ensurePeriodic(this)
        setContent {
            SecurityOpsApp(
                api = api,
                sessionStore = sessionStore,
                pendingOutbox = { database.outboxDao().pendingCount() },
                onNfcScan = { callback -> onNfcRead = callback; enableNfcReader() },
                onCameraCapture = { launchCamera() },
                onLogout = {
                    lifecycleScope.launch {
                        api.logout()
                        sessionStore.clear()
                    }
                },
            )
        }
    }

    private fun enableNfcReader() {
        nfcAdapter?.enableReaderMode(
            this,
            this,
            NfcAdapter.FLAG_READER_NFC_A or NfcAdapter.FLAG_READER_NFC_B or
                NfcAdapter.FLAG_READER_NFC_F or NfcAdapter.FLAG_READER_NFC_V,
            null,
        )
    }

    override fun onTagDiscovered(tag: Tag) {
        val value = tag.id.joinToString("") { byte -> "%02X".format(byte) }
        runOnUiThread { onNfcRead?.invoke(value) }
    }

    private fun launchCamera() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED
        ) {
            startActivityForResult(Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE), CAMERA_REQUEST)
        } else {
            requestPermissions(arrayOf(Manifest.permission.CAMERA), CAMERA_PERMISSION_REQUEST)
        }
    }

    override fun onPause() {
        nfcAdapter?.disableReaderMode(this)
        super.onPause()
    }

    companion object {
        private const val CAMERA_PERMISSION_REQUEST = 1001
        private const val CAMERA_REQUEST = 1002
    }
}

@androidx.compose.runtime.Composable
@androidx.compose.material3.ExperimentalMaterial3Api
private fun SecurityOpsApp(
    api: SecurityOpsApi,
    sessionStore: SecureSessionStore,
    pendingOutbox: suspend () -> Int,
    onNfcScan: (((String) -> Unit)) -> Unit,
    onCameraCapture: () -> Unit,
    onLogout: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    var session by remember { mutableStateOf(sessionStore.read()) }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var routeId by remember { mutableStateOf("") }
    var employeeId by remember { mutableStateOf("") }
    var nfcUid by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    var outboxCount by remember { mutableStateOf(0) }
    var busy by remember { mutableStateOf(false) }

    LaunchedEffect(session) { outboxCount = pendingOutbox() }
    MaterialTheme {
        Scaffold(
            topBar = { TopAppBar(title = { Text("SecurityOps Mobile") }) },
            snackbarHost = { SnackbarHost(snackbar) },
        ) { padding ->
            Column(
                modifier = Modifier.fillMaxSize().padding(padding).padding(20.dp)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                if (session == null) {
                    Text("Sichere Anmeldung", style = MaterialTheme.typography.headlineSmall)
                    OutlinedTextField(email, { email = it }, label = { Text("E-Mail") }, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(password, { password = it }, label = { Text("Passwort") }, modifier = Modifier.fillMaxWidth())
                    Button(
                        enabled = !busy && email.isNotBlank() && password.isNotBlank(),
                        onClick = {
                            busy = true
                            scope.launch {
                                runCatching { api.login(email, password) }
                                    .onSuccess { value -> session = value; SyncScheduler.runNow(context) }
                                    .onFailure { snackbar.showSnackbar(it.message ?: "Anmeldung fehlgeschlagen") }
                                busy = false
                            }
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text(if (busy) "Anmeldung läuft ..." else "Anmelden") }
                    Text("Die Session wird ausschließlich verschlüsselt im Android Keystore abgelegt.")
                } else {
                    Text("Mobiles Dashboard", style = MaterialTheme.typography.headlineSmall)
                    Card(modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text("Tenant: ${session?.tenantId ?: "unbekannt"}")
                            Text("Rolle: ${session?.role ?: "unbekannt"}")
                            Text("Status: Session aktiv")
                            Text("Offline-Outbox: $outboxCount")
                        }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { SyncScheduler.runNow(context) }) { Text("Synchronisieren") }
                        OutlinedButton(onClick = onLogout) { Text("Abmelden") }
                    }
                    Spacer(Modifier.height(4.dp))
                    Text("Kontrollpunkt", style = MaterialTheme.typography.titleLarge)
                    OutlinedTextField(routeId, { routeId = it }, label = { Text("Route-ID") }, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(employeeId, { employeeId = it }, label = { Text("Mitarbeiter-ID") }, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(nfcUid, { nfcUid = it }, label = { Text("NFC-Kennung") }, modifier = Modifier.fillMaxWidth())
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { onNfcScan { nfcUid = it } }) { Text("NFC lesen") }
                        OutlinedButton(onClick = onCameraCapture) { Text("Kamera") }
                    }
                    Button(
                        enabled = routeId.isNotBlank() && employeeId.isNotBlank() && nfcUid.isNotBlank(),
                        onClick = {
                            scope.launch {
                                runCatching { api.submitPatrolScan(routeId, employeeId, nfcUid) }
                                    .onSuccess { outboxCount = pendingOutbox() }
                                    .onFailure { snackbar.showSnackbar(it.message ?: "Scan konnte nicht gespeichert werden") }
                            }
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text("Kontrollpunkt bestätigen") }
                    Text("Panik-Alarm", style = MaterialTheme.typography.titleLarge)
                    OutlinedTextField(description, { description = it }, label = { Text("Beschreibung") }, modifier = Modifier.fillMaxWidth())
                    Button(
                        onClick = {
                            scope.launch {
                                runCatching { api.submitPanic(description.ifBlank { "Mobiler Panik-Alarm" }) }
                                    .onSuccess { outboxCount = pendingOutbox() }
                                    .onFailure { snackbar.showSnackbar(it.message ?: "Panik-Alarm konnte nicht gespeichert werden") }
                            }
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text("PANIK", color = MaterialTheme.colorScheme.onError) }
                }
            }
        }
    }
}
