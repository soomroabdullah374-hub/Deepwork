package expo.modules.deepworkcall

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

/** A call from JS: { id, at (epoch ms), title, body }. */
class CallSpec : Record {
  @Field
  val id: String = ""

  @Field
  val at: Double = 0.0

  @Field
  val title: String = "DeepWork"

  @Field
  val body: String = ""

  fun toCall(ringAt: Long = at.toLong()) = ScheduledCall(id, ringAt, title, body)
}

/**
 * Reminder calls: the phone rings like an incoming call (no phone number, nothing leaves
 * the phone) when a session's reminder went unanswered, and Answer opens the app's call
 * screen at deepwork://call/<session id>.
 */
class DeepworkCallModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("The app is not ready")

  override fun definition() = ModuleDefinition {
    Name("DeepworkCall")

    // Replaces every waiting call with these.
    Function("schedule") { calls: List<CallSpec> ->
      CallScheduler.replaceAll(context, calls.filter { it.id.isNotEmpty() }.map { it.toCall() })
    }

    Function("cancel") { id: String ->
      CallScheduler.cancel(context, id)
      CallNotifier.stop(context, id)
    }

    // A call that rings in `seconds` (the test call in Settings).
    Function("ringIn") { seconds: Double, call: CallSpec ->
      CallScheduler.add(context, call.toCall(System.currentTimeMillis() + (seconds * 1000).toLong()))
    }

    Function("stopRinging") { id: String ->
      CallNotifier.stop(context, id)
    }

    // Android 14+ asks the user before an app may ring over the lock screen.
    Function("canRingFullScreen") {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        context.getSystemService(NotificationManager::class.java)?.canUseFullScreenIntent() ?: true
      } else {
        true
      }
    }

    Function("openFullScreenSettings") {
      val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:${context.packageName}"))
      } else {
        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
      }
      context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
  }
}
