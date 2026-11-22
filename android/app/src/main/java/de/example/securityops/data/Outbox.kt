package de.example.securityops.data

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import java.util.UUID

@Entity(tableName = "mobile_outbox")
data class OutboxEntity(
    @androidx.room.PrimaryKey val id: String = UUID.randomUUID().toString(),
    val action: String,
    val path: String,
    val payload: String,
    val createdAt: Long = System.currentTimeMillis(),
    val status: String = "pending",
    val lastError: String? = null,
)

@Dao
interface OutboxDao {
    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insert(item: OutboxEntity)
    @Query("SELECT * FROM mobile_outbox WHERE status = 'pending' ORDER BY createdAt ASC")
    suspend fun pending(): List<OutboxEntity>
    @Query("SELECT COUNT(*) FROM mobile_outbox WHERE status != 'synced'")
    suspend fun pendingCount(): Int
    @Query("DELETE FROM mobile_outbox WHERE id = :id")
    suspend fun delete(id: String)
    @Query("UPDATE mobile_outbox SET status = :status, lastError = :error WHERE id = :id")
    suspend fun mark(id: String, status: String, error: String?)
}

@Database(entities = [OutboxEntity::class], version = 1, exportSchema = false)
abstract class MobileDatabase : RoomDatabase() {
    abstract fun outboxDao(): OutboxDao

    companion object {
        fun create(context: Context): MobileDatabase =
            Room.databaseBuilder(context, MobileDatabase::class.java, "securityops-mobile.db").build()
    }
}
