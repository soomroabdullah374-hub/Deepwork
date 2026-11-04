package expo.modules.deepworkcall

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject

/** One reminder call: rings at `at` (epoch ms) about the session `id`. */
data class ScheduledCall(val id: String, val at: Long, val title: String, val body: String) {
  fun toJson(): JSONObject = JSONObject().put("id", id).put("at", at).put("title", title).put("body", body)

  companion object {
    fun fromJson(o: JSONObject) = ScheduledCall(o.getString("id"), o.getLong("at"), o.optString("title"), o.optString("body"))
  }
}

/**
 * The calls waiting to ring, kept in shared preferences (so they survive the app being
 * closed, a restart and a reboot) with one exact alarm each.
 */
object CallScheduler {
  private const val PREFS = "deepwork.calls"
  private const val KEY = "scheduled"
  const val ACTION_RING = "expo.modules.deepworkcall.RING"
  const val EXTRA_ID = "id"

  fun replaceAll(context: Context, calls: List<ScheduledCall>) {
    load(context).forEach { cancelAlarm(context, it.id) }
    val now = System.currentTimeMillis()
    val future = calls.filter { it.at > now }.distinctBy { it.id }
    save(context, future)
    future.forEach { setAlarm(context, it) }
  }

  fun add(context: Context, call: ScheduledCall) {
    save(context, load(context).filter { it.id != call.id } + call)
    setAlarm(context, call)
  }

  fun cancel(context: Context, id: String) {
    cancelAlarm(context, id)
    save(context, load(context).filter { it.id != id })
  }

  /** The call that is due, taken off the list; null when it was cancelled meanwhile. */
  fun take(context: Context, id: String): ScheduledCall? {
    val all = load(context)
    val call = all.firstOrNull { it.id == id } ?: return null
    save(context, all.filter { it.id != id })
    return call
  }

  /** Alarms don't survive a reboot or an app update: set them again. */
  fun restoreAll(context: Context) {
    val now = System.currentTimeMillis()
    val keep = load(context).filter { it.at > now }
    save(context, keep)
    keep.forEach { setAlarm(context, it) }
  }

  private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  private fun load(context: Context): List<ScheduledCall> {
    val raw = prefs(context).getString(KEY, null) ?: return emptyList()
    return try {
      val array = JSONArray(raw)
      (0 until array.length()).map { ScheduledCall.fromJson(array.getJSONObject(it)) }
    } catch (e: Exception) {
      emptyList()
    }
  }

  private fun save(context: Context, calls: List<ScheduledCall>) {
    val array = JSONArray()
    calls.forEach { array.put(it.toJson()) }
    prefs(context).edit().putString(KEY, array.toString()).apply()
  }

  private fun alarmIntent(context: Context, id: String, create: Boolean): PendingIntent? {
    // the data makes each session's alarm its own PendingIntent
    val intent = Intent(context, CallAlarmReceiver::class.java)
      .setAction(ACTION_RING)
      .setData(Uri.parse("deepwork-call://ring/$id"))
      .putExtra(EXTRA_ID, id)
    val flags = PendingIntent.FLAG_IMMUTABLE or (if (create) PendingIntent.FLAG_UPDATE_CURRENT else PendingIntent.FLAG_NO_CREATE)
    return PendingIntent.getBroadcast(context, 0, intent, flags)
  }

  private fun setAlarm(context: Context, call: ScheduledCall) {
    val alarms = context.getSystemService(AlarmManager::class.java) ?: return
    val pending = alarmIntent(context, call.id, true) ?: return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !alarms.canScheduleExactAlarms()) {
      alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, call.at, pending)
    } else {
      alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, call.at, pending)
    }
  }

  private fun cancelAlarm(context: Context, id: String) {
    val pending = alarmIntent(context, id, false) ?: return
    context.getSystemService(AlarmManager::class.java)?.cancel(pending)
    pending.cancel()
  }
}
