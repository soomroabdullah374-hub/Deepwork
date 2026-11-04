package expo.modules.deepworkcall

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.content.ContextCompat

/** The ringing: a call-style notification that opens the call screen over the lock screen. */
object CallNotifier {
  const val CHANNEL = "deepwork-calls"
  private const val TAG = "deepwork-call"

  /** Rings this long, then counts as missed. */
  const val RING_MS = 45_000L

  private val VIBRATION = longArrayOf(0, 1000, 800, 1000, 800, 1000)

  @SuppressLint("MissingPermission")
  fun ring(context: Context, call: ScheduledCall) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) {
      return
    }
    ensureChannel(context)
    val code = call.id.hashCode()
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    val screen = PendingIntent.getActivity(context, code, CallActivity.intent(context, call, answer = false), flags)
    val answer = PendingIntent.getActivity(context, code + 1, CallActivity.intent(context, call, answer = true), flags)
    val decline = PendingIntent.getBroadcast(
      context,
      code + 2,
      Intent(context, CallActionReceiver::class.java)
        .setAction(CallActionReceiver.ACTION_DECLINE)
        .setData(Uri.parse("deepwork-call://decline/${call.id}"))
        .putExtra(CallScheduler.EXTRA_ID, call.id),
      flags,
    )
    val builder = NotificationCompat.Builder(context, CHANNEL)
      .setSmallIcon(smallIcon(context))
      .setContentTitle(call.title)
      .setContentText(call.body)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setOngoing(true)
      .setAutoCancel(false)
      .setTimeoutAfter(RING_MS)
      .setContentIntent(screen)
      .setFullScreenIntent(screen, true)
      .setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE))
      .setVibrate(VIBRATION)
    val manager = NotificationManagerCompat.from(context)
    try {
      val caller = Person.Builder().setName(call.title).setImportant(true).build()
      manager.notify(TAG, code, insistent(builder.setStyle(NotificationCompat.CallStyle.forIncomingCall(caller, decline, answer)).build()))
    } catch (e: Exception) {
      // Some phones refuse the call style (for example without full-screen permission):
      // ring with plain Answer / Decline buttons instead.
      Log.w(TAG, "call style refused, ringing without it", e)
      builder.setStyle(null)
      builder.addAction(0, "Decline", decline)
      builder.addAction(0, "Answer", answer)
      manager.notify(TAG, code, insistent(builder.build()))
    }
  }

  fun stop(context: Context, id: String) {
    NotificationManagerCompat.from(context).cancel(TAG, id.hashCode())
  }

  /** Keeps ringing until answered, declined or timed out. */
  private fun insistent(n: Notification): Notification {
    n.flags = n.flags or Notification.FLAG_INSISTENT
    return n
  }

  private fun ensureChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    if (manager.getNotificationChannel(CHANNEL) != null) return
    val channel = NotificationChannel(CHANNEL, "Reminder calls", NotificationManager.IMPORTANCE_HIGH).apply {
      description = "Rings like a phone call when a session's reminder went unanswered."
      setSound(
        RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
          .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
          .build(),
      )
      enableVibration(true)
      vibrationPattern = VIBRATION
      lockscreenVisibility = Notification.VISIBILITY_PUBLIC
    }
    manager.createNotificationChannel(channel)
  }

  @SuppressLint("DiscouragedApi")
  private fun smallIcon(context: Context): Int {
    // the white notification icon expo-notifications adds; the app icon as a fallback
    val id = context.resources.getIdentifier("notification_icon", "drawable", context.packageName)
    return if (id != 0) id else context.applicationInfo.icon
  }
}
