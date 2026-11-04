package expo.modules.deepworkcall

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** A call's time has come: ring, unless it was cancelled meanwhile. */
class CallAlarmReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val id = intent.getStringExtra(CallScheduler.EXTRA_ID) ?: return
    val call = CallScheduler.take(context, id) ?: return
    CallNotifier.ring(context, call)
  }
}

/** Decline on the notification: stop ringing and close the ringing screen. */
class CallActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val id = intent.getStringExtra(CallScheduler.EXTRA_ID) ?: return
    CallNotifier.stop(context, id)
    context.sendBroadcast(Intent(CallActivity.ACTION_CLOSE).setPackage(context.packageName).putExtra(CallScheduler.EXTRA_ID, id))
  }

  companion object {
    const val ACTION_DECLINE = "expo.modules.deepworkcall.DECLINE"
  }
}

/** Alarms are lost on a reboot or an app update: set the waiting calls again. */
class CallBootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
      CallScheduler.restoreAll(context)
    }
  }
}
