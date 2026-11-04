package expo.modules.deepworkcall

import android.app.Activity
import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.Space
import android.widget.TextView
import androidx.core.content.ContextCompat

/** The ringing screen, also over the lock screen: Answer opens the app's call, Decline stops it. */
class CallActivity : Activity() {
  private var call: ScheduledCall? = null

  // Decline from the notification closes this screen too.
  private val close = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      if (intent.getStringExtra(CallScheduler.EXTRA_ID) == call?.id) finish()
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val c = fromIntent(intent)
    if (c == null) {
      finish()
      return
    }
    call = c
    showOverLockScreen()
    ContextCompat.registerReceiver(this, close, IntentFilter(ACTION_CLOSE), ContextCompat.RECEIVER_NOT_EXPORTED)
    setContentView(layout(c))
    if (intent.getBooleanExtra(EXTRA_ANSWER, false)) {
      answer()
    } else {
      // unanswered: gone when the ringing stops
      window.decorView.postDelayed({ if (!isFinishing) finish() }, CallNotifier.RING_MS)
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    if (intent.getBooleanExtra(EXTRA_ANSWER, false)) answer()
  }

  override fun onDestroy() {
    try {
      unregisterReceiver(close)
    } catch (_: Exception) {
      // never registered
    }
    super.onDestroy()
  }

  @Suppress("OVERRIDE_DEPRECATION", "DEPRECATION")
  override fun onBackPressed() {
    call?.let { CallNotifier.stop(this, it.id) }
    super.onBackPressed()
  }

  private fun showOverLockScreen() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      setShowWhenLocked(true)
      setTurnScreenOn(true)
    } else {
      @Suppress("DEPRECATION")
      window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
    }
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
  }

  private fun answer() {
    val c = call ?: return
    CallNotifier.stop(this, c.id)
    val open = Intent(Intent.ACTION_VIEW, Uri.parse("deepwork://call/${c.id}"))
      .setPackage(packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    val keyguard = getSystemService(KeyguardManager::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && keyguard != null && keyguard.isKeyguardLocked) {
      // the app opens once the phone is unlocked
      keyguard.requestDismissKeyguard(
        this,
        object : KeyguardManager.KeyguardDismissCallback() {
          override fun onDismissSucceeded() = openApp(open)

          override fun onDismissError() = openApp(open)
        },
      )
    } else {
      openApp(open)
    }
  }

  private fun openApp(open: Intent) {
    startActivity(open)
    finish()
  }

  private fun decline() {
    call?.let { CallNotifier.stop(this, it.id) }
    finish()
  }

  private fun px(dp: Int) = (dp * resources.displayMetrics.density).toInt()

  private fun layout(c: ScheduledCall): View {
    val root = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER_HORIZONTAL
      setBackgroundColor(Color.parseColor("#141413"))
      setPadding(px(24), px(96), px(24), px(72))
    }
    root.addView(label("DeepWork", "#D97757", 16f))
    root.addView(label(c.title, "#FAF9F5", 30f).apply { setPadding(0, px(14), 0, px(8)) })
    root.addView(label(c.body, "#B0AEA5", 17f))
    root.addView(Space(this), LinearLayout.LayoutParams(0, 0, 1f))
    val row = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER
    }
    row.addView(button("Decline", "✕", "#C4453C") { decline() }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    row.addView(button("Answer", "📞", "#3E8E5B") { answer() }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    root.addView(row, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    return root
  }

  private fun label(text: String, color: String, size: Float) = TextView(this).apply {
    this.text = text
    setTextColor(Color.parseColor(color))
    textSize = size
    gravity = Gravity.CENTER
  }

  private fun button(name: String, glyph: String, color: String, onClick: () -> Unit): View {
    val fill = Color.parseColor(color)
    val column = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER_HORIZONTAL
    }
    val circle = label(glyph, "#FFFFFF", 28f).apply {
      background = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(fill)
      }
      contentDescription = name
      isClickable = true
      setOnClickListener { onClick() }
    }
    column.addView(circle, LinearLayout.LayoutParams(px(76), px(76)))
    column.addView(label(name, "#FAF9F5", 15f).apply { setPadding(0, px(10), 0, 0) })
    return column
  }

  companion object {
    const val ACTION_CLOSE = "expo.modules.deepworkcall.CLOSE"
    private const val EXTRA_ANSWER = "answer"
    private const val EXTRA_TITLE = "title"
    private const val EXTRA_BODY = "body"

    fun intent(context: Context, call: ScheduledCall, answer: Boolean): Intent =
      Intent(context, CallActivity::class.java)
        .setData(Uri.parse("deepwork-call://${if (answer) "answer" else "screen"}/${call.id}"))
        .putExtra(CallScheduler.EXTRA_ID, call.id)
        .putExtra(EXTRA_TITLE, call.title)
        .putExtra(EXTRA_BODY, call.body)
        .putExtra(EXTRA_ANSWER, answer)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_USER_ACTION)

    private fun fromIntent(intent: Intent?): ScheduledCall? {
      val id = intent?.getStringExtra(CallScheduler.EXTRA_ID) ?: return null
      return ScheduledCall(id, 0, intent.getStringExtra(EXTRA_TITLE) ?: "DeepWork", intent.getStringExtra(EXTRA_BODY) ?: "")
    }
  }
}
